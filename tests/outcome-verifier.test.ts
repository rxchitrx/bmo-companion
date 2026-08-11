import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicOutcomeVerifier,
  MAX_VERIFICATION_EVIDENCE,
  type VerificationEvidence,
} from "../electron/outcome-verifier.ts";

const directEvidence = (id = "state.final-observation"): VerificationEvidence => ({
  id,
  kind: "state-observation",
  source: "fixture-observer",
  polarity: "supports",
  strength: "direct",
  statement: "The final observed state directly satisfies the requested condition.",
});
test("direct supporting evidence produces a structured verified decision", () => {
  const decision = new DeterministicOutcomeVerifier().verify({
    summary: "The requested condition is visibly satisfied.",
    workerClaimedVerified: true,
    reconciliationRequired: false,
    evidence: [directEvidence()],
  });
  assert.equal(decision.status, "verified");
  assert.deepEqual(decision.reasons.map((reason) => reason.code), [
    "summary-present",
    "direct-supporting-evidence",
    "no-contradictory-evidence",
  ]);
  assert.deepEqual(decision.evidence, {
    considered: 1,
    supporting: 1,
    contradictory: 0,
    directSupporting: 1,
  });
});

test("a verified claim without evidence fails closed", () => {
  const decision = new DeterministicOutcomeVerifier().verify({
    summary: "Claimed complete.",
    workerClaimedVerified: true,
    reconciliationRequired: false,
    evidence: [],
  });
  assert.equal(decision.status, "unverified");
  assert.deepEqual(decision.reasons.map((reason) => reason.code), [
    "missing-evidence",
  ]);
});

test("contradictory evidence overrides supporting evidence deterministically", () => {
  const decision = new DeterministicOutcomeVerifier().verify({
    summary: "Claimed complete.",
    workerClaimedVerified: true,
    reconciliationRequired: false,
    evidence: [
      directEvidence("state.support"),
      {
        id: "state.contradiction",
        kind: "state-observation",
        source: "fixture-observer",
        polarity: "contradicts",
        strength: "direct",
        statement: "A later observation shows the requested condition is absent.",
      },
    ],
  });
  assert.equal(decision.status, "unverified");
  assert.deepEqual(decision.reasons.map((reason) => reason.code), [
    "contradictory-evidence",
  ]);
  assert.deepEqual(decision.reasons[0]?.evidenceIds, ["state.contradiction"]);
});

test("indirect, invalid, or over-limit evidence cannot verify an outcome", () => {
  const verifier = new DeterministicOutcomeVerifier();
  const indirect = verifier.verify({
    summary: "Claimed complete.",
    workerClaimedVerified: true,
    reconciliationRequired: false,
    evidence: [{ ...directEvidence(), strength: "indirect" }],
  });
  assert.ok(indirect.reasons.some((reason) =>
    reason.code === "insufficient-direct-evidence"));

  const duplicate = verifier.verify({
    summary: "Claimed complete.",
    workerClaimedVerified: true,
    reconciliationRequired: false,
    evidence: [directEvidence("duplicate"), directEvidence("duplicate")],
  });
  assert.ok(duplicate.reasons.some((reason) => reason.code === "invalid-evidence"));

  const overLimit = verifier.verify({
    summary: "Claimed complete.",
    workerClaimedVerified: true,
    reconciliationRequired: false,
    evidence: Array.from(
      { length: MAX_VERIFICATION_EVIDENCE + 1 },
      (_, index) => directEvidence(`state.${index}`),
    ),
  });
  assert.ok(overLimit.reasons.some((reason) =>
    reason.code === "evidence-limit-exceeded"));
});

test("missing summary, worker rejection, and reconciliation retain separate reasons", () => {
  const decision = new DeterministicOutcomeVerifier().verify({
    summary: "",
    workerClaimedVerified: false,
    reconciliationRequired: true,
    evidence: [{
      id: "kernel.reconciliation-required",
      kind: "reconciliation",
      source: "kernel",
      polarity: "contradicts",
      strength: "direct",
      statement: "Current state must be reconciled.",
    }],
  });
  assert.deepEqual(decision.reasons.map((reason) => reason.code), [
    "missing-summary",
    "worker-reported-unverified",
    "reconciliation-required",
    "contradictory-evidence",
    "insufficient-direct-evidence",
  ]);
});
