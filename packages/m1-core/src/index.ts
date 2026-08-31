import { createHash } from "node:crypto";
import type { ParsedCandidate } from "@boss-forge/contracts";
import type { CandidateEvaluationRecord, RuleConfig } from "@boss-forge/data";
import { evaluateTem8 } from "@boss-forge/rule-engine";

function normalizedFields(fields: Record<string, string>): Array<[string, string]> {
  return Object.entries(fields)
    .map(([key, value]) => [key.trim().toLocaleLowerCase("zh-CN"), value.trim()] as [string, string])
    .sort(([left], [right]) => left.localeCompare(right));
}

export function candidateFingerprint(candidate: ParsedCandidate): string {
  const identity = JSON.stringify({
    name: candidate.name.trim().toLocaleLowerCase("zh-CN"),
    fields: normalizedFields(candidate.fields)
  });
  return createHash("sha256").update(identity).digest("hex");
}

export function candidateRuleText(candidate: ParsedCandidate): string {
  return [
    candidate.raw,
    ...Object.entries(candidate.fields).map(([key, value]) => `${key}：${value}`),
    ...candidate.evidence
  ]
    .filter(Boolean)
    .join("。");
}

export function evaluateCandidate(
  candidate: ParsedCandidate,
  ruleConfig: RuleConfig
): CandidateEvaluationRecord {
  const tem8Requirement = ruleConfig.requiredCapabilities.find(
    (item) => item.capability === "tem8"
  );
  if (!tem8Requirement) {
    throw new Error("M1 currently requires a TEM8 capability rule.");
  }
  const ruleText = candidateRuleText(candidate);
  const evaluation = evaluateTem8(ruleText);
  const belowConfiguredConfidence =
    evaluation.decision === "matched" && evaluation.confidence < tem8Requirement.minimumConfidence;
  return {
    sourceReference: `${candidate.source}:${candidate.index}:${candidate.name}`,
    source: candidate.source,
    displayName: candidate.name,
    fingerprint: candidateFingerprint(candidate),
    rawFields: candidate.fields,
    sourceEvidence: candidate.evidence,
    rawText: ruleText,
    decision: belowConfiguredConfidence ? "ambiguous" : evaluation.decision,
    confidence: evaluation.confidence,
    capabilityId: evaluation.capabilityId,
    canonicalLabel: evaluation.canonicalLabel,
    dictionaryVersion: evaluation.dictionaryVersion,
    reasonCodes: belowConfiguredConfidence
      ? [...evaluation.reasonCodes, "below_configured_confidence"]
      : evaluation.reasonCodes,
    evidence: evaluation.evidence
  };
}
