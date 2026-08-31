import type { ParsedCandidate } from "@boss-forge/contracts";
import { candidateFingerprint } from "@boss-forge/m1-core";

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}
/**
 * boss-cli preview/greet currently accepts a display name, not an immutable candidate ID.
 * Refuse the side effect whenever the refreshed list cannot prove that the name is unique
 * and that its stable card fingerprint still matches the collected candidate.
 */
export function selectUnambiguousCandidateTarget(
  expected: ParsedCandidate,
  current: ParsedCandidate[]
): ParsedCandidate {
  const expectedFingerprint = candidateFingerprint(expected);
  const exactCandidates = current.filter(
    (candidate) => candidateFingerprint(candidate) === expectedFingerprint
  );
  const sameNameCandidates = current.filter(
    (candidate) => normalizedName(candidate.name) === normalizedName(expected.name)
  );
  if (exactCandidates.length !== 1 || sameNameCandidates.length !== 1) {
    throw new Error(
      "Candidate target is missing or ambiguous after refreshing the BOSS result list; operation was blocked."
    );
  }
  return exactCandidates[0]!;
}
