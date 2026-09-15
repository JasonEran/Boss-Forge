import { screeningCandidateLimit } from "@boss-forge/contracts";
import type { CandidateEvaluationRecord } from "./types.js";

/** Deduplicate before applying the admission cap. DOM size is never a budget. */
export function limitScreeningRecords(records: CandidateEvaluationRecord[], limit: number): CandidateEvaluationRecord[] {
  const maximum = screeningCandidateLimit(limit);
  const seen = new Set<string>();
  const selected: CandidateEvaluationRecord[] = [];
  for (const record of records) {
    const key = record.sourceLocator?.kind === "boss_geek_id"
      ? `boss:${record.sourceLocator.value.trim()}`
      : `fingerprint:${record.fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(record);
    if (selected.length === maximum) break;
  }
  return selected;
}
