import type {
  CapabilityEvaluation,
  CapabilityEvidence,
  CapabilityEvidenceStatus,
  CapabilityReasonCode
} from "./types.js";

const CAPABILITY_ID = "language.english.tem8";
const CANONICAL_LABEL = "TEM-8（英语专业八级）";
const DICTIONARY_VERSION = "2026.08.1";
const CONTEXT_RADIUS = 14;

type AliasPattern = {
  normalizedAlias: string;
  pattern: RegExp;
  confidence: number;
  subjectiveWhenQualified?: boolean;
};

type LocatedAlias = AliasPattern & {
  index: number;
  length: number;
};

const ALIASES: readonly AliasPattern[] = [
  {
    normalizedAlias: "Test for English Majors Band 8",
    pattern: /test\s+for\s+english\s+majors?\s+band\s*(?:8|eight)/giu,
    confidence: 0.99
  },
  {
    normalizedAlias: "TEM-8",
    pattern: /\btem[\s‐‑‒–—−-]*8\b/giu,
    confidence: 0.99
  },
  {
    normalizedAlias: "英语专业八级",
    pattern: /英语\s*专业\s*(?:八|8)\s*级/giu,
    confidence: 0.99
  },
  {
    normalizedAlias: "英语专八",
    pattern: /英语\s*专\s*(?:八|8)/giu,
    confidence: 0.97
  },
  {
    normalizedAlias: "专八",
    pattern: /专\s*(?:八|8)(?!\s*级)/giu,
    confidence: 0.95,
    subjectiveWhenQualified: true
  },
  {
    normalizedAlias: "英语八级",
    pattern: /英语\s*(?:八|8)\s*级/giu,
    confidence: 0.86,
    subjectiveWhenQualified: true
  }
] as const;

const NEGATIVE_CONTEXT =
  /未\s*(?:通过|取得|获得|持有|达到|考过|拿到)|没\s*(?:通过|取得|获得|考过|拿到)|没有\s*(?:通过|取得|获得|证书)|不具备|未获证|挂科/iu;
const PLANNED_CONTEXT =
  /备考|准备|计划|报考|即将\s*(?:参加|考试)|将\s*(?:参加|考试)|正在\s*(?:考|准备)|待考|目标|争取/iu;
const SUBJECTIVE_CONTEXT = /水平|接近|相当于|媲美|能力\s*(?:达到|接近)/iu;
const CONFUSABLE_CREDENTIAL =
  /\bCET[\s-]*(?:4|6)\b|大学英语\s*(?:四|六|4|6)\s*级|雅思\s*8(?:\.0)?\s*分?|IELTS\s*8(?:\.0)?/iu;

function normalizeInput(text: string): string {
  return text.normalize("NFKC").replace(/[\u00a0\u2000-\u200d\u202f\u205f\u3000]/gu, " ");
}

function locateAliases(text: string): LocatedAlias[] {
  const located: LocatedAlias[] = [];
  for (const alias of ALIASES) {
    alias.pattern.lastIndex = 0;
    for (const match of text.matchAll(alias.pattern)) {
      if (match.index === undefined || !match[0]) continue;
      located.push({ ...alias, index: match.index, length: match[0].length });
    }
  }

  located.sort((left, right) => left.index - right.index || right.length - left.length);
  const selected: LocatedAlias[] = [];
  for (const item of located) {
    const overlaps = selected.some(
      (existing) =>
        item.index < existing.index + existing.length && existing.index < item.index + item.length
    );
    if (!overlaps) selected.push(item);
  }
  return selected.sort((left, right) => left.index - right.index);
}

function evidenceStatus(item: LocatedAlias, context: string): CapabilityEvidenceStatus {
  if (NEGATIVE_CONTEXT.test(context)) return "negative";
  if (PLANNED_CONTEXT.test(context)) return "ambiguous";
  if (item.subjectiveWhenQualified && SUBJECTIVE_CONTEXT.test(context)) return "ambiguous";
  return "positive";
}

function evidenceWindow(text: string, item: LocatedAlias): string {
  const punctuation = /[；;。\n！？!?]/u;
  let start = Math.max(0, item.index - CONTEXT_RADIUS);
  let end = Math.min(text.length, item.index + item.length + CONTEXT_RADIUS);

  for (let index = item.index - 1; index >= start; index -= 1) {
    if (punctuation.test(text[index] ?? "")) {
      start = index + 1;
      break;
    }
  }
  for (let index = item.index + item.length; index < end; index += 1) {
    if (punctuation.test(text[index] ?? "")) {
      end = index;
      break;
    }
  }
  return text.slice(start, end).trim();
}

function buildEvidence(text: string, item: LocatedAlias): CapabilityEvidence {
  const sourceText = evidenceWindow(text, item);
  const status = evidenceStatus(item, sourceText);
  const confidence =
    status === "positive" ? item.confidence : status === "negative" ? 0.99 : 0.6;
  return {
    sourceText,
    normalizedAlias: item.normalizedAlias,
    status,
    confidence
  };
}

function uniqueReasons(reasons: CapabilityReasonCode[]): CapabilityReasonCode[] {
  return [...new Set(reasons)];
}

export function evaluateTem8(rawText: string): CapabilityEvaluation {
  const text = normalizeInput(rawText);
  const evidence = locateAliases(text).map((item) => buildEvidence(text, item));
  const positive = evidence.filter((item) => item.status === "positive");
  const negative = evidence.filter((item) => item.status === "negative");
  const ambiguous = evidence.filter((item) => item.status === "ambiguous");

  if (positive.length > 0 && negative.length > 0) {
    return {
      capabilityId: CAPABILITY_ID,
      canonicalLabel: CANONICAL_LABEL,
      dictionaryVersion: DICTIONARY_VERSION,
      decision: "ambiguous",
      confidence: 0.5,
      reasonCodes: ["conflicting_evidence"],
      evidence
    };
  }

  if (positive.length > 0) {
    return {
      capabilityId: CAPABILITY_ID,
      canonicalLabel: CANONICAL_LABEL,
      dictionaryVersion: DICTIONARY_VERSION,
      decision: "matched",
      confidence: Math.max(...positive.map((item) => item.confidence)),
      reasonCodes: ["confirmed_alias"],
      evidence
    };
  }

  if (ambiguous.length > 0) {
    const reasons: CapabilityReasonCode[] = [];
    for (const item of ambiguous) {
      if (PLANNED_CONTEXT.test(item.sourceText)) reasons.push("planned_or_in_progress");
      if (SUBJECTIVE_CONTEXT.test(item.sourceText)) reasons.push("subjective_proficiency");
    }
    return {
      capabilityId: CAPABILITY_ID,
      canonicalLabel: CANONICAL_LABEL,
      dictionaryVersion: DICTIONARY_VERSION,
      decision: "ambiguous",
      confidence: 0.6,
      reasonCodes: uniqueReasons(reasons),
      evidence
    };
  }

  if (negative.length > 0) {
    return {
      capabilityId: CAPABILITY_ID,
      canonicalLabel: CANONICAL_LABEL,
      dictionaryVersion: DICTIONARY_VERSION,
      decision: "not_matched",
      confidence: 0.99,
      reasonCodes: ["negative_context"],
      evidence
    };
  }

  const hasConfusableCredential = CONFUSABLE_CREDENTIAL.test(text);
  return {
    capabilityId: CAPABILITY_ID,
    canonicalLabel: CANONICAL_LABEL,
    dictionaryVersion: DICTIONARY_VERSION,
    decision: hasConfusableCredential ? "not_matched" : "insufficient",
    confidence: hasConfusableCredential ? 0.98 : 0,
    reasonCodes: [hasConfusableCredential ? "confusable_credential" : "no_evidence"],
    evidence: []
  };
}
