import assert from "node:assert/strict";
import { test } from "node:test";
import { assessOciAlwaysFreeCandidate } from "./oci-free-policy.mjs";

const valid = {
  region: "uk-london-1",
  homeRegion: "uk-london-1",
  shape: "VM.Standard.A1.Flex",
  ocpus: 1,
  memoryGb: 6,
  bootGb: 50,
  tenancyUsedA1Ocpus: 1,
  tenancyUsedA1MemoryGb: 6,
  tenancyUsedBlockGb: 50,
  tenancyWideEvidence: true,
  billingStatusReviewed: true,
  allowPaid: false,
};

test("offline candidate satisfies numeric Always Free ceilings but never confirms capacity", () => {
  assert.deepEqual(assessOciAlwaysFreeCandidate(valid), {
    ok: true,
    issues: [],
    capacityVerified: false,
    billingApproval: false,
  });
});

test("non-home region and paid permission are rejected", () => {
  const result = assessOciAlwaysFreeCandidate({
    ...valid,
    region: "us-ashburn-1",
    allowPaid: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("TARGET_MUST_BE_HOME_REGION"));
  assert.ok(result.issues.includes("CHARGEABLE_SERVICES_FORBIDDEN"));
});

test("unverified totals cannot be mistaken for free unused capacity", () => {
  const result = assessOciAlwaysFreeCandidate({
    ...valid,
    tenancyUsedA1Ocpus: undefined,
    tenancyUsedA1MemoryGb: undefined,
    tenancyUsedBlockGb: undefined,
    tenancyWideEvidence: false,
    billingStatusReviewed: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("TENANCY_WIDE_EVIDENCE_REQUIRED"));
  assert.ok(result.issues.includes("BILLING_STATUS_REVIEW_REQUIRED"));
  assert.ok(result.issues.includes("A1_OCPU_ALLOWANCE_EXCEEDED_OR_UNVERIFIED"));
});

test("quota oversubscription is rejected across compute, memory and block storage", () => {
  const result = assessOciAlwaysFreeCandidate({
    ...valid,
    ocpus: 2,
    memoryGb: 12,
    bootGb: 160,
  });
  assert.equal(result.ok, false);
  for (const code of [
    "A1_OCPU_ALLOWANCE_EXCEEDED_OR_UNVERIFIED",
    "A1_MEMORY_ALLOWANCE_EXCEEDED_OR_UNVERIFIED",
    "BLOCK_STORAGE_ALLOWANCE_EXCEEDED_OR_UNVERIFIED",
  ]) {
    assert.ok(result.issues.includes(code), code);
  }
});

test("non-free shapes, fractional CPUs, invalid sizes and malformed inputs are rejected", () => {
  assert.deepEqual(assessOciAlwaysFreeCandidate(null), {
    ok: false,
    issues: ["CANDIDATE_INVALID"],
    capacityVerified: false,
  });
  const result = assessOciAlwaysFreeCandidate({
    ...valid,
    shape: "VM.Standard.E5.Flex",
    ocpus: 0.5,
    memoryGb: Infinity,
    bootGb: 40,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("ARM_ALWAYS_FREE_SHAPE_REQUIRED"));
  assert.ok(result.issues.includes("A1_OCPU_ALLOWANCE_EXCEEDED_OR_UNVERIFIED"));
  assert.ok(result.issues.includes("A1_MEMORY_ALLOWANCE_EXCEEDED_OR_UNVERIFIED"));
  assert.ok(result.issues.includes("BLOCK_STORAGE_ALLOWANCE_EXCEEDED_OR_UNVERIFIED"));
});

test("floating-point or string usage cannot silently bypass ceilings", () => {
  const result = assessOciAlwaysFreeCandidate({
    ...valid,
    tenancyUsedA1Ocpus: "0",
    tenancyUsedBlockGb: "0",
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("A1_OCPU_ALLOWANCE_EXCEEDED_OR_UNVERIFIED"));
  assert.ok(result.issues.includes("BLOCK_STORAGE_ALLOWANCE_EXCEEDED_OR_UNVERIFIED"));
});
