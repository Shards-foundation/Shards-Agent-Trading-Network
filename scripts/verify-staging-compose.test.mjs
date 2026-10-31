import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const validator = fileURLToPath(new URL("./verify-staging-compose.mjs", import.meta.url));
const baseEnv = {
  NODE_ENV: "production",
  EXECUTION_MODE: "PAPER",
  LIVE_EXECUTION_ENABLED: "false",
  DATABASE_URL: "postgresql://fixture:fixture@db.example.com/satn?sslmode=require",
  REDIS_URL: "rediss://fixture:fixture@cache.example.com:6380",
  WEB_ORIGIN: "https://staging.example.com",
  OIDC_ISSUER: "https://issuer.example.com/",
  OIDC_AUDIENCE: "satn-api",
  OIDC_JWKS_URL: "https://issuer.example.com/.well-known/jwks.json",
};
const service = {
  image: "satn-backend:ci-fixture",
  init: true,
  read_only: true,
  security_opt: ["no-new-privileges:true"],
  cap_drop: ["ALL"],
  environment: baseEnv,
};
function configuration() {
  return {
    services: {
      api: {
        ...service,
        restart: "unless-stopped",
        command: ["node", "apps/api/dist/index.js"],
        environment: { ...baseEnv, API_HOST: "0.0.0.0" },
        ports: [{ host_ip: "127.0.0.1", target: 4000 }],
        healthcheck: {
          test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4000/health/ready')"],
        },
      },
      worker: {
        ...service,
        restart: "unless-stopped",
        command: ["node", "apps/api/dist/worker-main.js"],
        environment: { ...baseEnv },
      },
      migrate: {
        ...service,
        restart: "no",
        command: ["pnpm", "--filter", "@satn/database", "db:migrate:deploy"],
        environment: { ...baseEnv },
      },
    },
  };
}
function check(config) {
  return spawnSync(process.execPath, [validator], {
    input: JSON.stringify(config),
    encoding: "utf8",
    timeout: 5000,
  });
}
function rejects(config, reason) {
  const result = check(config);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(`STAGING_TOPOLOGY_${reason}`));
}

test("accepts a synthetic, isolated paper-only staging topology", () => {
  const result = check(configuration());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configuration only/);
});

test("denies live trading flags and untrusted bootstrap registration", () => {
  const live = configuration();
  live.services.worker.environment.EXECUTION_MODE = "LIVE_RESTRICTED";
  rejects(live, "worker_EXECUTION_MODE");
  const boot = configuration();
  boot.services.api.environment.AGENT_REGISTRATION_TOKEN = "never-log-this";
  rejects(boot, "api_BOOTSTRAP_TOKEN");
});

test("denies publicly bound API or a published worker port", () => {
  const publicApi = configuration();
  publicApi.services.api.ports[0].host_ip = "0.0.0.0";
  rejects(publicApi, "API_LOOPBACK_ONLY");
  const workerPort = configuration();
  workerPort.services.worker.ports = [{ target: 4000, published: "4000" }];
  rejects(workerPort, "PRIVATE_SERVICE_PORTS");
});

test("denies missing HTTPS OIDC and unpinned images", () => {
  const insecure = configuration();
  insecure.services.api.environment.OIDC_JWKS_URL = "http://issuer.example.com/jwks.json";
  rejects(insecure, "api_OIDC_JWKS_URL_HTTPS");
  const mutable = configuration();
  mutable.services.migrate.image = "satn-backend:latest";
  rejects(mutable, "migrate_UNPINNED_IMAGE");
});

test("rejects malformed credential-bearing endpoints without logging secret input", () => {
  const malformed = configuration();
  malformed.services.api.environment.DATABASE_URL = "postgresql://admin:SECRET-DO-NOT-PRINT@";
  const result = check(malformed);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STAGING_TOPOLOGY_api_DATABASE_TLS/);
  assert.equal(result.stderr.includes("SECRET-DO-NOT-PRINT"), false);
  assert.equal(result.stdout.includes("SECRET-DO-NOT-PRINT"), false);
});
