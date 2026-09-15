import type { ParsedCandidate } from "@boss-forge/contracts";
import { candidateFingerprint } from "@boss-forge/m1-core";

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function hasSameSourceLocator(left: ParsedCandidate, right: ParsedCandidate): boolean {
  return Boolean(
    left.sourceLocator &&
      right.sourceLocator &&
      left.sourceLocator.kind === right.sourceLocator.kind &&
      left.sourceLocator.value === right.sourceLocator.value
  );
}

function cardFingerprintWithoutLocator(candidate: ParsedCandidate): string {
  return candidateFingerprint({
    index: candidate.index,
    name: candidate.name,
    source: candidate.source,
    fields: candidate.fields,
    evidence: candidate.evidence,
    raw: candidate.raw
  });
}
/**
 * Prefer the opaque BOSS card ID captured during collection. Older snapshots do
 * not have it, so they retain the stricter name + card fingerprint fallback.
 */
export function selectUnambiguousCandidateTarget(
  expected: ParsedCandidate,
  current: ParsedCandidate[],
  options: {
    allowExpiredLocatorFingerprintFallback?: boolean;
  } = {}
): ParsedCandidate {
  if (expected.sourceLocator) {
    const stableMatches = current.filter((candidate) =>
      hasSameSourceLocator(expected, candidate)
    );
    if (stableMatches.length === 1) return stableMatches[0]!;
    if (stableMatches.length > 1) {
      throw new Error(
        `BOSS_TARGET_AMBIGUOUS：BOSS 返回了重复的候选人标识，为避免看错人已停止自动操作。`
      );
    }
    if (options.allowExpiredLocatorFingerprintFallback) {
      const expectedFingerprint = cardFingerprintWithoutLocator(expected);
      const fingerprintMatches = current.filter(
        (candidate) => cardFingerprintWithoutLocator(candidate) === expectedFingerprint
      );
      const sameNameMatches = current.filter(
        (candidate) => normalizedName(candidate.name) === normalizedName(expected.name)
      );
      // BOSS may replace the opaque card ID when its recommendation iframe is
      // refreshed. Resume preview is read-only, so accept the replacement only
      // when both the stable card fingerprint and unique display name prove it is
      // still the collected candidate. Never use this fallback for contact writes.
      if (fingerprintMatches.length === 1 && sameNameMatches.length === 1) {
        return fingerprintMatches[0]!;
      }
    }
    throw new Error(
      `BOSS_SOURCE_EXPIRED：候选人“${expected.name}”的原始 BOSS 卡片已不在该岗位列表中。系统没有改看其他人，请重新采集该岗位。`
    );
  }
  const expectedFingerprint = candidateFingerprint(expected);
  const exactCandidates = current.filter(
    (candidate) => candidateFingerprint(candidate) === expectedFingerprint
  );
  const sameNameCandidates = current.filter(
    (candidate) => normalizedName(candidate.name) === normalizedName(expected.name)
  );
  if (sameNameCandidates.length === 0) {
    throw new Error(
      `BOSS_TARGET_MISSING：刷新后未在当前候选人列表中找到“${expected.name}”。请重新采集该岗位后再精筛。`
    );
  }
  if (sameNameCandidates.length > 1) {
    throw new Error(
      `BOSS_TARGET_AMBIGUOUS：当前列表中有 ${sameNameCandidates.length} 位同名“${expected.name}”，为避免看错人已停止自动操作。`
    );
  }
  if (exactCandidates.length === 1) return exactCandidates[0]!;
  throw new Error(
    `BOSS_TARGET_CHANGED：候选人“${expected.name}”的卡片信息已变化，为避免联系错人已停止自动操作。`
  );
}
