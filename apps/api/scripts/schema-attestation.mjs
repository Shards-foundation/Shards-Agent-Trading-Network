import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The checked-in Prisma schema creates exactly these public application tables.
// Do not use a simple count: an unrelated table must never satisfy the gate.
export const REQUIRED_TABLES = Object.freeze([
  "Agent",
  "AgentCredential",
  "AgentFollow",
  "AgentPost",
  "AgentPostLike",
  "AgentPostReport",
  "AgentRegistration",
  "AuditEvent",
  "Fill",
  "JournalEntry",
  "NetworkComment",
  "NetworkCommunity",
  "NetworkSubscription",
  "NetworkVote",
  "PerformanceSnapshot",
  "RiskDecision",
  "RiskPolicy",
  "StrategyVersion",
  "TradeIntent",
  "User",
  "VenueOrder",
  "WorkerHeartbeat",
  "WorkerJob",
]);

export function assessMigrationLedger({
  actualDatabase,
  expectedDatabase,
  expectedMigrations,
  appliedMigrations,
  tables,
  ledgerPresent,
}) {
  const issues = [];
  const add = (code, valid) => {
    if (!valid) issues.push(code);
  };

  add(
    "EXPECTED_DATABASE_INVALID",
    typeof expectedDatabase === "string" &&
      /^[a-z][a-z0-9_]{0,62}$/.test(expectedDatabase),
  );
  add("DATABASE_NAME_MISMATCH", actualDatabase === expectedDatabase);
  add("MIGRATION_LEDGER_MISSING", ledgerPresent === true);
  const actualTables = new Set(tables);
  add("REQUIRED_APPLICATION_TABLES_MISSING", REQUIRED_TABLES.every((name) => actualTables.has(name)));
  const requiredMigrations = new Set(expectedMigrations);
  const validMigrations = appliedMigrations.filter(
    (row) => row.finished && !row.rolledBack,
  );
  const actualMigrations = new Set(validMigrations.map((row) => row.name));
  add("CHECKED_IN_MIGRATIONS_MISSING", [...requiredMigrations].every((name) => actualMigrations.has(name)));
  add("UNREVIEWED_MIGRATION_APPLIED", validMigrations.every((row) => requiredMigrations.has(row.name)));
  add(
    "INCOMPLETE_OR_ROLLED_BACK_MIGRATION",
    appliedMigrations.every((row) => row.finished && !row.rolledBack),
  );
  add(
    "DUPLICATE_MIGRATION_RECORD",
    actualMigrations.size === validMigrations.length,
  );
  add("NO_CHECKED_IN_MIGRATIONS", requiredMigrations.size > 0);
  return {
    ok: issues.length === 0,
    issues,
    expectedMigrationCount: requiredMigrations.size,
    appliedMigrationCount: validMigrations.length,
    requiredTableCount: REQUIRED_TABLES.length,
    presentTableCount: REQUIRED_TABLES.filter((name) => actualTables.has(name)).length,
  };
}

export async function checkedInMigrations() {
  const directory = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../packages/database/prisma/migrations",
  );
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-zA-Z0-9_]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function run() {
  let prisma;
  const expectedDatabase = process.env.SATNS_EXPECTED_DATABASE;
  const expectedMigrations = await checkedInMigrations();

  try {
    // Imported only during the executable run; pure assertion tests require
    // no connection, environment secrets, or database schema.
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();
    const databaseRows = await prisma.$queryRaw`
      SELECT current_database()::text AS name,
             to_regclass('public._prisma_migrations') IS NOT NULL AS "ledgerPresent"
    `;
    const database = databaseRows[0];
    // Fail before reading other schemas if this is not the declared target DB.
    if (database?.name !== expectedDatabase || !database?.ledgerPresent) {
      const verdict = assessMigrationLedger({
        actualDatabase: database?.name,
        expectedDatabase,
        expectedMigrations,
        appliedMigrations: [],
        tables: [],
        ledgerPresent: database?.ledgerPresent,
      });
      console.info(JSON.stringify({ event: "satns.database.migration_attestation", status: "HALTED", ...verdict }));
      process.exitCode = 1;
      return;
    }
    const [migrationRows, tableRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT migration_name AS name,
               finished_at IS NOT NULL AS finished,
               rolled_back_at IS NOT NULL AS "rolledBack"
        FROM public._prisma_migrations
      `,
      prisma.$queryRaw`
        SELECT table_name AS name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `,
    ]);
    const verdict = assessMigrationLedger({
      actualDatabase: database.name,
      expectedDatabase,
      expectedMigrations,
      appliedMigrations: migrationRows,
      tables: tableRows.map((row) => row.name),
      ledgerPresent: true,
    });
    console.info(
      JSON.stringify({
        event: "satns.database.migration_attestation",
        status: verdict.ok ? "PASS" : "HALTED",
        ...verdict,
      }),
    );
    if (!verdict.ok) process.exitCode = 1;
  } catch {
    // Never print raw DB errors or connection strings to CI logs.
    console.error(JSON.stringify({
      event: "satns.database.migration_attestation",
      status: "HALTED",
      issues: ["DATABASE_ATTESTATION_QUERY_FAILED"],
    }));
    process.exitCode = 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await run();
}
