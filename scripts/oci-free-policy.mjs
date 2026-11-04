import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Offline, read-only eligibility gate. Passing does not establish live OCI
// capacity, actual billing status, reserved capacity or tenancy-wide quota.
const REGION = /^[a-z]{2}-[a-z][a-z0-9-]*-[1-9][0-9]*$/;

function count(value, { min = 0, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < min || (integer && !Number.isSafeInteger(value))) return null;
  return value;
}

export function assessOciAlwaysFreeCandidate(candidate) {
  const issues = [];
  const requireValue = (code, condition) => {
    if (!condition) issues.push(code);
  };

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, issues: ["CANDIDATE_INVALID"], capacityVerified: false };
  }

  const region = candidate.region;
  const homeRegion = candidate.homeRegion;
  requireValue(
    "HOME_REGION_REQUIRED",
    typeof homeRegion === "string" && REGION.test(homeRegion),
  );
  requireValue(
    "TARGET_MUST_BE_HOME_REGION",
    typeof region === "string" &&
      REGION.test(region) &&
      region === homeRegion,
  );
  requireValue(
    "ARM_ALWAYS_FREE_SHAPE_REQUIRED",
    candidate.shape === "VM.Standard.A1.Flex",
  );
  const ocpus = count(candidate.ocpus, { min: 1, integer: true });
  const memory = count(candidate.memoryGb, { min: 1 });
  const boot = count(candidate.bootGb, { min: 50, integer: true });
  const existingOcpus = count(candidate.tenancyUsedA1Ocpus);
  const existingMemory = count(candidate.tenancyUsedA1MemoryGb);
  const existingBlock = count(candidate.tenancyUsedBlockGb);
  requireValue(
    "A1_OCPU_ALLOWANCE_EXCEEDED_OR_UNVERIFIED",
    ocpus !== null &&
      existingOcpus !== null &&
      ocpus + existingOcpus <= 2,
  );
  requireValue(
    "A1_MEMORY_ALLOWANCE_EXCEEDED_OR_UNVERIFIED",
    memory !== null &&
      existingMemory !== null &&
      memory + existingMemory <= 12,
  );
  requireValue(
    "BLOCK_STORAGE_ALLOWANCE_EXCEEDED_OR_UNVERIFIED",
    boot !== null && existingBlock !== null && boot + existingBlock <= 200,
  );
  requireValue("CHARGEABLE_SERVICES_FORBIDDEN", candidate.allowPaid === false);
  requireValue(
    "TENANCY_WIDE_EVIDENCE_REQUIRED",
    candidate.tenancyWideEvidence === true,
  );
  requireValue(
    "BILLING_STATUS_REVIEW_REQUIRED",
    candidate.billingStatusReviewed === true,
  );
  return {
    ok: issues.length === 0,
    issues,
    capacityVerified: false,
    billingApproval: false,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Deliberately no API calls and no cloud writes in this script.
  const result = assessOciAlwaysFreeCandidate({});
  console.info(
    JSON.stringify({
      event: "oci.always_free.offline_gate",
      status: result.ok ? "ELIGIBLE_BY_STATIC_POLICY" : "BLOCKED",
      issues: result.issues,
      capacityVerified: false,
      resourcesCreated: 0,
      liveTradingEnabled: false,
    }),
  );
  if (!result.ok) process.exitCode = 1;
}
