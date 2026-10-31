import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const yaml = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");

// A narrow security contract for this reviewed Blueprint, not a general YAML
// parser. Prettier's YAML parser separately checks valid syntax in CI.
function verifyBlueprint(source) {
  const headers = [...source.matchAll(/^  - type: (web|worker)$/gm)];
  assert.deepEqual(
    headers.map((match) => match[1]),
    ["web", "worker"],
    "Staging requires exactly one API web service and one independent worker",
  );
  assert.match(source, /^previews:\n  generation: off$/m);

  const blocks = headers.map((match, index) =>
    source.slice(
      match.index,
      headers[index + 1]?.index ?? source.length,
    ),
  );
  const [api, worker] = blocks;
  assert.ok(api && worker);

  for (const [name, block] of [
    ["api", api],
    ["worker", worker],
  ]) {
    assert.match(block, /^    runtime: docker$/m, name);
    assert.match(block, /^    region: frankfurt$/m, name);
    assert.match(block, /^    plan: 0\.5c-512mb$/m, name);
    assert.match(block, /^    autoDeployTrigger: off$/m, name);
    assert.match(block, /^    dockerfilePath: \.\/deploy\/Dockerfile$/m, name);
    assert.match(block, /^    dockerContext: \.$/m, name);
    assert.match(block, /^      - key: NODE_ENV\n        value: production$/m, name);
    assert.match(block, /^      - key: EXECUTION_MODE\n        value: PAPER$/m, name);
    assert.match(
      block,
      /^      - key: LIVE_EXECUTION_ENABLED\n        value: "false"$/m,
      name,
    );
    assert.match(block, /^      - key: WORKER_QUEUE\n        value: default$/m, name);
    for (const required of [
      "DATABASE_URL",
      "REDIS_URL",
      "WEB_ORIGIN",
      "OIDC_ISSUER",
      "OIDC_AUDIENCE",
      "OIDC_JWKS_URL",
    ]) {
      assert.match(
        block,
        new RegExp(`^      - key: ${required}\\n        sync: false$`, "m"),
        `${name} must request protected ${required} at provisioning`,
      );
    }
    assert.doesNotMatch(block, /AGENT_REGISTRATION_TOKEN/);
    assert.doesNotMatch(block, /\bLIVE_RESTRICTED\b|\bTESTNET\b|\bMAINNET\b/);
  }

  assert.match(api, /^    name: satn-staging-api$/m);
  assert.match(api, /^    dockerCommand: node apps\/api\/dist\/index\.js$/m);
  assert.match(
    api,
    /^    preDeployCommand: pnpm --filter @satn\/database db:migrate:deploy$/m,
  );
  assert.match(api, /^    healthCheckPath: \/health\/ready$/m);
  assert.match(api, /^      - key: API_HOST\n        value: 0\.0\.0\.0$/m);
  assert.match(api, /^      - key: API_PORT\n        value: "10000"$/m);
  assert.match(worker, /^    name: satn-staging-worker$/m);
  assert.match(
    worker,
    /^    dockerCommand: node apps\/api\/dist\/worker-main\.js$/m,
  );
  assert.doesNotMatch(worker, /healthCheckPath:|preDeployCommand:|ports:/);
}

test("hardened Render Blueprint matches the controlled PAPER deployment contract", () => {
  verifyBlueprint(yaml);
});

test("rejects an execution mode change", () => {
  assert.throws(() =>
    verifyBlueprint(yaml.replace("value: PAPER", "value: LIVE_RESTRICTED")),
  );
});

test("rejects automatic deployments and unapproved free worker mode", () => {
  assert.throws(() =>
    verifyBlueprint(yaml.replace("autoDeployTrigger: off", "autoDeployTrigger: commit")),
  );
  assert.throws(() =>
    verifyBlueprint(yaml.replace("plan: 0.5c-512mb", "plan: free")),
  );
});

test("rejects credentials embedded in the Blueprint", () => {
  assert.throws(() =>
    verifyBlueprint(yaml.replace(
      "- key: DATABASE_URL\n        sync: false",
      "- key: DATABASE_URL\n        value: postgresql://not-allowed",
    )),
  );
});

test("rejects removing or combining the worker process", () => {
  assert.throws(() =>
    verifyBlueprint(yaml.replace("  - type: worker", "  - type: web")),
  );
});
