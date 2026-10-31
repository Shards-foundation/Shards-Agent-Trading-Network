import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_TABLES,
  assessMigrationLedger,
  checkedInMigrations,
} from "./schema-attestation.mjs";

const migration = "20261030000000_init";
const passing = {
  actualDatabase: "neondb",
  expectedDatabase: "neondb",
  expectedMigrations: [migration],
  appliedMigrations: [
    { name: migration, finished: true, rolledBack: false },
  ],
  tables: [...REQUIRED_TABLES],
  ledgerPresent: true,
};

test("accepts exact database, required tables and completed ledger", () => {
  const result = assessMigrationLedger(passing);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(result.appliedMigrationCount, 1);
  assert.equal(result.requiredTableCount, 23);
});

test("distinguishes a copied schema from a genuine Prisma migration", () => {
  const result = assessMigrationLedger({
    ...passing,
    appliedMigrations: [],
    ledgerPresent: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("MIGRATION_LEDGER_MISSING"));
  assert.ok(result.issues.includes("CHECKED_IN_MIGRATIONS_MISSING"));
});

test("rejects wrong database even with fully populated schema and ledger", () => {
  const result = assessMigrationLedger({
    ...passing,
    actualDatabase: "satn",
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("DATABASE_NAME_MISMATCH"));
});

test("rejects partial, rolled-back and duplicate migrations", () => {
  for (const entry of [
    { name: migration, finished: false, rolledBack: false },
    { name: migration, finished: true, rolledBack: true },
  ]) {
    const result = assessMigrationLedger({
      ...passing,
      appliedMigrations: [entry],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("INCOMPLETE_OR_ROLLED_BACK_MIGRATION"));
  }
  const duplicate = assessMigrationLedger({
    ...passing,
    appliedMigrations: [...passing.appliedMigrations, ...passing.appliedMigrations],
  });
  assert.ok(duplicate.issues.includes("DUPLICATE_MIGRATION_RECORD"));
});

test("rejects unreviewed migrations and absent application tables", () => {
  const result = assessMigrationLedger({
    ...passing,
    tables: REQUIRED_TABLES.slice(1),
    appliedMigrations: [
      ...passing.appliedMigrations,
      { name: "20261031999999_unreviewed", finished: true, rolledBack: false },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("UNREVIEWED_MIGRATION_APPLIED"));
  assert.ok(result.issues.includes("REQUIRED_APPLICATION_TABLES_MISSING"));
});

test("rejects missing expected migrations and invalid database target", () => {
  const result = assessMigrationLedger({
    ...passing,
    expectedDatabase: "neondb/other",
    expectedMigrations: [migration, "20261030010000_durable_worker_jobs"],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("EXPECTED_DATABASE_INVALID"));
  assert.ok(result.issues.includes("DATABASE_NAME_MISMATCH"));
  assert.ok(result.issues.includes("CHECKED_IN_MIGRATIONS_MISSING"));
});

test("enumerates the committed migration folders without arbitrary paths", async () => {
  const names = await checkedInMigrations();
  assert.ok(names.length >= 10);
  assert.ok(names.includes(migration));
  assert.ok(names.every((name) => /^\d{14}_[a-zA-Z0-9_]+$/.test(name)));
  assert.deepEqual(names, [...names].sort());
});
