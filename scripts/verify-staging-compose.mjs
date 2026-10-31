import { readFileSync } from "node:fs";

// Validates the RESOLVED Docker Compose JSON without printing any values.
// Never paste 'docker compose config' output: it contains secret environment variables.
const fail = (code) => {
  throw new Error(`STAGING_TOPOLOGY_${code}`);
};
const check = (condition, code) => {
  if (!condition) fail(code);
};

// Malformed credential-bearing URLs must never surface in an exception message.
function urlOrNull(value) {
  if (typeof value !== "string") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

let compose;
try {
  compose = JSON.parse(readFileSync(0, "utf8"));
} catch {
  fail("INVALID_JSON");
}
const services = compose?.services;
check(services && typeof services === "object", "SERVICES_MISSING");
check(
  JSON.stringify(Object.keys(services).sort()) ===
    JSON.stringify(["api", "migrate", "worker"]),
  "UNEXPECTED_SERVICES",
);

for (const [name, service] of Object.entries(services)) {
  const env = service.environment;
  check(env && typeof env === "object", `${name}_ENV_MISSING`);
  check(env.NODE_ENV === "production", `${name}_NODE_ENV`);
  check(env.EXECUTION_MODE === "PAPER", `${name}_EXECUTION_MODE`);
  check(env.LIVE_EXECUTION_ENABLED === "false", `${name}_LIVE_FLAG`);
  check(!("AGENT_REGISTRATION_TOKEN" in env), `${name}_BOOTSTRAP_TOKEN`);
  const databaseUrl = urlOrNull(env.DATABASE_URL);
  check(
    databaseUrl !== null &&
      ["postgresql:", "postgres:"].includes(databaseUrl.protocol) &&
      ["require", "verify-ca", "verify-full"].includes(
        databaseUrl.searchParams.get("sslmode"),
      ),
    `${name}_DATABASE_TLS`,
  );
  const redisUrl = urlOrNull(env.REDIS_URL);
  check(redisUrl?.protocol === "rediss:", `${name}_REDIS_TLS`);
  for (const key of ["WEB_ORIGIN", "OIDC_ISSUER", "OIDC_JWKS_URL"]) {
    const url = urlOrNull(env[key]);
    check(
      url?.protocol === "https:" && !url.username && !url.password,
      `${name}_${key}_HTTPS`,
    );
  }
  check(
    typeof env.OIDC_AUDIENCE === "string" && env.OIDC_AUDIENCE.trim().length > 0,
    `${name}_OIDC_AUDIENCE`,
  );
  check(service.read_only === true, `${name}_READ_ONLY`);
  check(service.init === true, `${name}_INIT`);
  check(service.cap_drop?.includes("ALL"), `${name}_CAPABILITIES`);
  check(
    service.security_opt?.includes("no-new-privileges:true"),
    `${name}_PRIVILEGES`,
  );
  check(typeof service.image === "string", `${name}_IMAGE`);
  check(
    !service.image.endsWith(":latest") && service.image.includes(":"),
    `${name}_UNPINNED_IMAGE`,
  );
}

const api = services.api;
const worker = services.worker;
const migrate = services.migrate;
check(
  api.command?.join(" ") === "node apps/api/dist/index.js",
  "API_ENTRYPOINT",
);
check(
  worker.command?.join(" ") === "node apps/api/dist/worker-main.js",
  "WORKER_ENTRYPOINT",
);
check(
  migrate.command?.join(" ") ===
    "pnpm --filter @satn/database db:migrate:deploy",
  "MIGRATION_ENTRYPOINT",
);
check(api.restart === "unless-stopped", "API_RESTART");
check(worker.restart === "unless-stopped", "WORKER_RESTART");
check(migrate.restart === "no", "MIGRATION_RESTART");
check(!worker.ports && !migrate.ports, "PRIVATE_SERVICE_PORTS");
check(
  Array.isArray(api.ports) &&
    api.ports.length === 1 &&
    api.ports[0].host_ip === "127.0.0.1" &&
    api.ports[0].target === 4000,
  "API_LOOPBACK_ONLY",
);
check(
  api.healthcheck?.test?.some((x) => x.includes("/health/ready")),
  "API_READINESS_PROBE",
);
check(api.environment.API_HOST === "0.0.0.0", "API_BIND");

process.stdout.write(
  "Staging compose security and process topology verified (configuration only; no runtime proof).\n",
);
