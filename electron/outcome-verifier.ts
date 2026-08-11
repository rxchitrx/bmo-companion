export const VERIFICATION_FRAMEWORK_VERSION = 1 as const;
export const MAX_VERIFICATION_EVIDENCE = 32;

export type VerificationEvidenceKind =
  | "worker-contract"
  | "protocol-settlement"
  | "state-observation"
  | "tool-result"
  | "artifact"
  | "reconciliation";

export interface VerificationEvidence {
  id: string;
  kind: VerificationEvidenceKind;
  source: string;
  polarity: "supports" | "contradicts";
  strength: "direct" | "indirect";
  statement: string;
}

export type VerificationFailureReasonCode =
  | "missing-summary"
  | "worker-reported-unverified"
  | "reconciliation-required"
  | "missing-evidence"
  | "contradictory-evidence"
  | "insufficient-direct-evidence"
  | "invalid-evidence"
  | "evidence-limit-exceeded";

export type VerificationSuccessReasonCode =
  | "summary-present"
  | "direct-supporting-evidence"
  | "no-contradictory-evidence";

export interface VerificationReason<
  Code extends VerificationFailureReasonCode | VerificationSuccessReasonCode =
    VerificationFailureReasonCode | VerificationSuccessReasonCode,
> {
  code: Code;
  evidenceIds: string[];
}

interface VerificationEvidenceCounts {
  considered: number;
  supporting: number;
  contradictory: number;
  directSupporting: number;
}

export interface VerifiedDecision {
  version: typeof VERIFICATION_FRAMEWORK_VERSION;
  status: "verified";
  reasons: VerificationReason<VerificationSuccessReasonCode>[];
  evidence: VerificationEvidenceCounts;
}

export interface UnverifiedDecision {
  version: typeof VERIFICATION_FRAMEWORK_VERSION;
  status: "unverified";
  reasons: [
    VerificationReason<VerificationFailureReasonCode>,
    ...VerificationReason<VerificationFailureReasonCode>[],
  ];
  evidence: VerificationEvidenceCounts;
}

export type VerificationDecision = VerifiedDecision | UnverifiedDecision;

export interface VerificationRequest {
  summary: string;
  workerClaimedVerified: boolean;
  reconciliationRequired: boolean;
  evidence: readonly VerificationEvidence[];
}

export interface OutcomeVerifier {
  verify(request: VerificationRequest): VerificationDecision;
}

const EVIDENCE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export function boundVerificationEvidence(
  evidence: readonly VerificationEvidence[],
): VerificationEvidence[] {
  return evidence.slice(0, MAX_VERIFICATION_EVIDENCE).map((item) => ({
    ...item,
    id: item.id.slice(0, 128),
    source: item.source.slice(0, 128),
    statement: item.statement.slice(0, 500),
  }));
}

function invalidEvidenceIds(evidence: readonly VerificationEvidence[]) {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const item of evidence.slice(0, MAX_VERIFICATION_EVIDENCE)) {
    if (
      !EVIDENCE_ID.test(item.id) ||
      item.source.trim().length === 0 ||
      item.source.length > 128 ||
      item.statement.trim().length === 0 ||
      item.statement.length > 500 ||
      seen.has(item.id)
    ) {
      invalid.push(item.id.slice(0, 128));
    }
    seen.add(item.id);
  }
  return invalid.sort();
}

export class DeterministicOutcomeVerifier implements OutcomeVerifier {
  verify(request: VerificationRequest): VerificationDecision {
    const evidence = boundVerificationEvidence(request.evidence);
    const supporting = evidence.filter((item) => item.polarity === "supports");
    const contradictory = evidence.filter((item) => item.polarity === "contradicts");
    const directSupporting = supporting.filter((item) => item.strength === "direct");
    const invalidIds = invalidEvidenceIds(request.evidence);
    const failures: VerificationReason<VerificationFailureReasonCode>[] = [];

    if (!request.summary.trim()) {
      failures.push({ code: "missing-summary", evidenceIds: [] });
    }
    if (!request.workerClaimedVerified) {
      failures.push({ code: "worker-reported-unverified", evidenceIds: [] });
    }
    if (request.reconciliationRequired) {
      failures.push({
        code: "reconciliation-required",
        evidenceIds: contradictory
          .filter((item) => item.kind === "reconciliation")
          .map((item) => item.id)
          .sort(),
      });
    }
    if (request.evidence.length === 0) {
      failures.push({ code: "missing-evidence", evidenceIds: [] });
    }
    if (request.evidence.length > MAX_VERIFICATION_EVIDENCE) {
      failures.push({ code: "evidence-limit-exceeded", evidenceIds: [] });
    }
    if (invalidIds.length > 0) {
      failures.push({ code: "invalid-evidence", evidenceIds: invalidIds });
    }
    if (contradictory.length > 0) {
      failures.push({
        code: "contradictory-evidence",
        evidenceIds: contradictory.map((item) => item.id).sort(),
      });
    }
    if (request.evidence.length > 0 && directSupporting.length === 0) {
      failures.push({ code: "insufficient-direct-evidence", evidenceIds: [] });
    }

    const counts = {
      considered: evidence.length,
      supporting: supporting.length,
      contradictory: contradictory.length,
      directSupporting: directSupporting.length,
    };
    if (failures.length > 0) {
      return {
        version: VERIFICATION_FRAMEWORK_VERSION,
        status: "unverified",
        reasons: [failures[0]!, ...failures.slice(1)],
        evidence: counts,
      };
    }
    return {
      version: VERIFICATION_FRAMEWORK_VERSION,
      status: "verified",
      reasons: [
        { code: "summary-present", evidenceIds: [] },
        {
          code: "direct-supporting-evidence",
          evidenceIds: directSupporting.map((item) => item.id).sort(),
        },
        { code: "no-contradictory-evidence", evidenceIds: [] },
      ],
      evidence: counts,
    };
  }
}

export const defaultOutcomeVerifier: OutcomeVerifier =
  new DeterministicOutcomeVerifier();
