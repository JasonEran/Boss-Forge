import type { ParsedCandidate } from "@boss-forge/contracts";
import type {
  CandidateEvaluationRecord,
  EducationLevel,
  EducationLevelRuleNode,
  EnumRuleNode,
  KeywordRuleNode,
  RangeRuleNode,
  TextRuleNode,
  UnknownPolicy
} from "@boss-forge/data";

type CandidateDecision = CandidateEvaluationRecord["decision"];
type RecordEvidence = CandidateEvaluationRecord["evidence"][number];

export type GenericRuleNode =
  | RangeRuleNode
  | KeywordRuleNode
  | EnumRuleNode
  | TextRuleNode
  | EducationLevelRuleNode;

export type RuntimeNodeDecision = CandidateDecision | "ignored";

export type GenericRuleEvaluation = {
  decision: RuntimeNodeDecision;
  confidence: number;
  reasonCodes: string[];
  evidence: RecordEvidence[];
  /** True when the decision came from missing, conflicting, or only partially bounded data. */
  unknown: boolean;
};

type SourceValue = {
  sourceText: string;
  value: string;
};

type UnknownInput = {
  policy: UnknownPolicy;
  capabilityId: string;
  canonicalLabel: string;
  sourceText: string;
  normalizedAlias: string;
  reasonCodes: string[];
  kind?: "missing" | "ambiguous";
};

const SCHEMA_VERSION = "rule-schema-1.0";
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  yearsofexperience: [
    "yearsofexperience",
    "experienceyears",
    "经验",
    "工作经验",
    "工作年限",
    "从业年限",
    "经验年限"
  ],
  educationlevel: ["educationlevel", "学历", "最高学历", "学历层次", "学位"],
  skills: ["skills", "skill", "技能", "专业技能", "核心技能", "技能特长", "技术栈"],
  location: ["location", "地点", "城市", "工作地点", "期望地点", "期望城市"],
  status: ["status", "状态", "求职状态", "在职状态"],
  bossplatformtags: [
    "bossplatformtags",
    "boss平台标签",
    "平台标签",
    "boss标签",
    "院校标签",
    "学校标签",
    "标签"
  ]
};

const EXPERIENCE_FIELD_KEYS = new Set(FIELD_ALIASES.yearsofexperience);
const EDUCATION_FIELD_KEYS = new Set(FIELD_ALIASES.educationlevel);
const EDUCATION_RANK: Readonly<Record<EducationLevel, number>> = {
  high_school: 0,
  associate: 1,
  bachelor: 2,
  master: 3,
  doctor: 4
};
const EDUCATION_LABEL: Readonly<Record<EducationLevel, string>> = {
  high_school: "高中/中专",
  associate: "专科",
  bachelor: "本科",
  master: "硕士",
  doctor: "博士"
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeField(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s:：=_\-/]/gu, "")
    .trim();
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\u00a0\u2000-\u200d\u202f\u205f\u3000]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function evidenceSnippet(sourceText: string, expected: string): string {
  if (sourceText.length <= 500) return sourceText;
  const source = sourceText.toLocaleLowerCase("zh-CN");
  const needle = expected.toLocaleLowerCase("zh-CN");
  const index = source.indexOf(needle);
  if (index < 0) return `${sourceText.slice(0, 497)}...`;
  const start = Math.max(0, index - 180);
  const end = Math.min(sourceText.length, index + expected.length + 180);
  return `${start > 0 ? "..." : ""}${sourceText.slice(start, end)}${
    end < sourceText.length ? "..." : ""
  }`;
}

function fieldKeys(field: string): ReadonlySet<string> {
  const normalized = normalizeField(field);
  return new Set(FIELD_ALIASES[normalized] ?? [normalized]);
}

function explicitFieldValues(candidate: ParsedCandidate, field: string): SourceValue[] {
  const accepted = fieldKeys(field);
  return Object.entries(candidate.fields)
    .filter(([key, value]) => accepted.has(normalizeField(key)) && Boolean(value.trim()))
    .map(([key, value]) => ({ sourceText: `${key}：${value.trim()}`, value: value.trim() }));
}

function allTextValues(
  candidate: ParsedCandidate,
  ruleText: string,
  resumeText: string | null | undefined
): SourceValue[] {
  const sources: SourceValue[] = [
    ...Object.entries(candidate.fields)
      .filter(([, value]) => Boolean(value.trim()))
      .map(([key, value]) => ({ sourceText: `${key}：${value.trim()}`, value: value.trim() })),
    ...candidate.evidence
      .filter((value) => Boolean(value.trim()))
      .map((value) => ({ sourceText: value.trim(), value: value.trim() })),
    ...(candidate.raw.trim()
      ? [{ sourceText: candidate.raw.trim(), value: candidate.raw.trim() }]
      : []),
    ...(resumeText?.trim()
      ? [{ sourceText: resumeText.trim(), value: resumeText.trim() }]
      : [])
  ];
  if (sources.length === 0 && ruleText.trim()) {
    sources.push({ sourceText: ruleText.trim(), value: ruleText.trim() });
  }
  return sources;
}

function selectedValues(
  candidate: ParsedCandidate,
  field: string,
  ruleText: string,
  resumeText: string | null | undefined
): SourceValue[] {
  return normalizeField(field) === "all"
    ? allTextValues(candidate, ruleText, resumeText)
    : explicitFieldValues(candidate, field);
}

function leafEvidence(
  capabilityId: string,
  canonicalLabel: string,
  sourceText: string,
  normalizedAlias: string,
  status: RecordEvidence["status"],
  confidence: number,
  reasonCodes: string[]
): RecordEvidence {
  return {
    sourceText,
    normalizedAlias,
    status,
    confidence,
    capabilityId,
    canonicalLabel,
    dictionaryVersion: SCHEMA_VERSION,
    reasonCodes
  };
}

function unknownEvaluation(input: UnknownInput): GenericRuleEvaluation {
  const policyReason = `unknown_policy_${input.policy}`;
  const reasonCodes = unique([...input.reasonCodes, policyReason]);
  let decision: RuntimeNodeDecision;
  switch (input.policy) {
    case "manual_review":
      decision = input.kind === "ambiguous" ? "ambiguous" : "insufficient";
      break;
    case "fail":
      decision = "not_matched";
      break;
    case "ignore":
      decision = "ignored";
      break;
  }
  return {
    decision,
    confidence: 0,
    reasonCodes,
    evidence: [
      leafEvidence(
        input.capabilityId,
        input.canonicalLabel,
        input.sourceText,
        input.normalizedAlias,
        "ambiguous",
        0,
        reasonCodes
      )
    ],
    unknown: true
  };
}

function findMatch(
  sources: SourceValue[],
  expected: string,
  match: "exact" | "contains",
  splitExact: boolean
): SourceValue | undefined {
  const normalizedExpected = normalizeText(expected);
  return sources.find((source) => {
    const normalizedSource = normalizeText(source.value);
    if (match === "contains") return normalizedSource.includes(normalizedExpected);
    if (normalizedSource === normalizedExpected) return true;
    if (!splitExact) return false;
    return normalizedSource
      .split(/[,，;；/|、]/u)
      .map((value) => value.trim())
      .includes(normalizedExpected);
  });
}

function evaluateValueSet(
  input: {
    type: "keyword" | "enum";
    field: string;
    values: string[];
    mode: "any" | "all";
    match: "exact" | "contains";
    unknownPolicy: UnknownPolicy;
  },
  candidate: ParsedCandidate,
  ruleText: string,
  resumeText: string | null | undefined
): GenericRuleEvaluation {
  const capabilityId = `${input.type}.${normalizeField(input.field)}`;
  const canonicalLabel = `${input.type === "keyword" ? "关键词" : "枚举"}（${input.field}）`;
  const sources = selectedValues(candidate, input.field, ruleText, resumeText);
  if (sources.length === 0) {
    return unknownEvaluation({
      policy: input.unknownPolicy,
      capabilityId,
      canonicalLabel,
      sourceText: `未找到字段：${input.field}`,
      normalizedAlias: "missing_field",
      reasonCodes: ["field_missing"]
    });
  }

  const results = input.values.map((value) => ({
    value,
    source: findMatch(sources, value, input.match, input.type === "enum")
  }));
  const matched =
    input.mode === "all"
      ? results.every((result) => result.source !== undefined)
      : results.some((result) => result.source !== undefined);
  const reasonCodes = [
    `${input.type}_${matched ? "matched" : "not_matched"}`,
    `${input.type}_mode_${input.mode}`,
    `${input.type}_match_${input.match}`
  ];
  return {
    decision: matched ? "matched" : "not_matched",
    confidence: 1,
    reasonCodes,
    evidence: results.map((result) =>
      leafEvidence(
        capabilityId,
        canonicalLabel,
        result.source
          ? evidenceSnippet(result.source.sourceText, result.value)
          : `未匹配：${result.value}`,
        normalizeText(result.value),
        result.source ? "positive" : "negative",
        1,
        reasonCodes
      )
    ),
    unknown: false
  };
}

function evaluateKeyword(
  node: KeywordRuleNode,
  candidate: ParsedCandidate,
  ruleText: string,
  resumeText: string | null | undefined
): GenericRuleEvaluation {
  return evaluateValueSet(
    { ...node, match: "contains" },
    candidate,
    ruleText,
    resumeText
  );
}

function evaluateEnum(
  node: EnumRuleNode,
  candidate: ParsedCandidate,
  ruleText: string,
  resumeText: string | null | undefined
): GenericRuleEvaluation {
  return evaluateValueSet(node, candidate, ruleText, resumeText);
}

function evaluateText(
  node: TextRuleNode,
  candidate: ParsedCandidate,
  ruleText: string,
  resumeText: string | null | undefined
): GenericRuleEvaluation {
  const capabilityId = `text.${normalizeField(node.field)}`;
  const canonicalLabel = `文本（${node.field}）${node.match === "exact" ? "等于" : "包含"}${node.value}`;
  const sources = selectedValues(candidate, node.field, ruleText, resumeText);
  if (sources.length === 0) {
    return unknownEvaluation({
      policy: node.unknownPolicy,
      capabilityId,
      canonicalLabel,
      sourceText: `未找到字段：${node.field}`,
      normalizedAlias: "missing_field",
      reasonCodes: ["field_missing"]
    });
  }
  const source = findMatch(sources, node.value, node.match, false);
  const matched = source !== undefined;
  const reasonCodes = [`text_${node.match}_${matched ? "matched" : "not_matched"}`];
  return {
    decision: matched ? "matched" : "not_matched",
    confidence: 1,
    reasonCodes,
    evidence: [
      leafEvidence(
        capabilityId,
        canonicalLabel,
        source ? evidenceSnippet(source.sourceText, node.value) : `未匹配：${node.value}`,
        normalizeText(node.value),
        matched ? "positive" : "negative",
        1,
        reasonCodes
      )
    ],
    unknown: false
  };
}

type ExperienceInterval = {
  minimum: number;
  maximum: number;
  sourceText: string;
};

function experienceInterval(source: SourceValue): ExperienceInterval | null {
  const value = normalizeText(source.value);
  if (/(?:无经验|零经验|应届(?:生|毕业生)?|no\s+experience|fresh\s+graduate)/iu.test(value)) {
    return { minimum: 0, maximum: 0, sourceText: source.sourceText };
  }
  const month = value.match(/(\d+(?:\.\d+)?)\s*(?:个?月|months?)/iu);
  if (month?.[1]) {
    const years = Number(month[1]) / 12;
    return { minimum: years, maximum: years, sourceText: source.sourceText };
  }
  const bounded = value.match(
    /(\d+(?:\.\d+)?)\s*(?:-|~|—|至|到)\s*(\d+(?:\.\d+)?)\s*(?:年|years?|yrs?)/iu
  );
  if (bounded?.[1] && bounded[2]) {
    const left = Number(bounded[1]);
    const right = Number(bounded[2]);
    return {
      minimum: Math.min(left, right),
      maximum: Math.max(left, right),
      sourceText: source.sourceText
    };
  }
  const atLeast = value.match(
    /(?:(\d+(?:\.\d+)?)\s*(?:年|years?|yrs?)?\s*(?:以上|及以上|or\s+more)|(\d+(?:\.\d+)?)\+\s*(?:年|years?|yrs?)?)/iu
  );
  const atLeastValue = atLeast?.[1] ?? atLeast?.[2];
  if (atLeastValue) {
    return {
      minimum: Number(atLeastValue),
      maximum: Number.POSITIVE_INFINITY,
      sourceText: source.sourceText
    };
  }
  const atMost = value.match(
    /(?:(?:不足|少于|less\s+than|up\s+to)\s*)?(\d+(?:\.\d+)?)\s*(?:年|years?|yrs?)(?:以下|以内|\s+or\s+less)?/iu
  );
  if (
    atMost?.[1] &&
    /(?:不足|少于|以下|以内|less\s+than|up\s+to|or\s+less)/iu.test(value)
  ) {
    return { minimum: 0, maximum: Number(atMost[1]), sourceText: source.sourceText };
  }
  const exact = value.match(/(\d+(?:\.\d+)?)\s*(?:年|years?|yrs?)/iu);
  if (exact?.[1]) {
    const years = Number(exact[1]);
    return { minimum: years, maximum: years, sourceText: source.sourceText };
  }
  return null;
}

function labeledExperienceValues(candidate: ParsedCandidate, resumeText?: string | null): SourceValue[] {
  const values = Object.entries(candidate.fields)
    .filter(([key, value]) => EXPERIENCE_FIELD_KEYS.has(normalizeField(key)) && Boolean(value.trim()))
    .map(([key, value]) => ({ sourceText: `${key}：${value.trim()}`, value: value.trim() }));
  const textSources = [candidate.raw, resumeText ?? ""].filter((value) => Boolean(value.trim()));
  const pattern = /(?:工作经验|工作年限|从业年限|经验年限|经验|years?\s+of\s+experience|work\s+experience|experience)\s*[:：=]\s*([^,，。;；\n|｜]{1,30})/giu;
  for (const text of textSources) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]?.trim()) {
        values.push({ sourceText: match[0].trim(), value: match[1].trim() });
      }
    }
  }
  return values;
}

function intervalKey(value: ExperienceInterval): string {
  return `${value.minimum}:${value.maximum}`;
}

function evaluateRange(
  node: RangeRuleNode,
  candidate: ParsedCandidate,
  resumeText: string | null | undefined
): GenericRuleEvaluation {
  const capabilityId = "range.yearsOfExperience";
  const canonicalLabel = `工作经验 ${node.minimum ?? "不限"}–${node.maximum ?? "不限"} 年`;
  const sources = labeledExperienceValues(candidate, resumeText);
  const parsed = sources.map(experienceInterval).filter((value): value is ExperienceInterval => value !== null);
  const byInterval = new Map<string, ExperienceInterval>();
  for (const value of parsed) {
    if (!byInterval.has(intervalKey(value))) byInterval.set(intervalKey(value), value);
  }
  const distinct = [...byInterval.values()];
  if (distinct.length === 0) {
    return unknownEvaluation({
      policy: node.unknownPolicy,
      capabilityId,
      canonicalLabel,
      sourceText: sources[0]?.sourceText ?? "未提取到明确工作年限",
      normalizedAlias: "missing_years_of_experience",
      reasonCodes: sources.length > 0 ? ["range_unparseable"] : ["field_missing"]
    });
  }
  if (distinct.length > 1) {
    return unknownEvaluation({
      policy: node.unknownPolicy,
      capabilityId,
      canonicalLabel,
      sourceText: distinct.map((value) => value.sourceText).join(" / "),
      normalizedAlias: "conflicting_years_of_experience",
      reasonCodes: ["range_conflicting_values"],
      kind: "ambiguous"
    });
  }
  const interval = distinct[0]!;
  const requiredMinimum = node.minimum ?? Number.NEGATIVE_INFINITY;
  const requiredMaximum = node.maximum ?? Number.POSITIVE_INFINITY;
  const disjoint = interval.maximum < requiredMinimum || interval.minimum > requiredMaximum;
  const contained = interval.minimum >= requiredMinimum && interval.maximum <= requiredMaximum;
  if (!disjoint && !contained) {
    return unknownEvaluation({
      policy: node.unknownPolicy,
      capabilityId,
      canonicalLabel,
      sourceText: interval.sourceText,
      normalizedAlias: `${interval.minimum}..${interval.maximum}`,
      reasonCodes: ["range_partially_overlaps"],
      kind: "ambiguous"
    });
  }
  const matched = contained;
  const reasonCodes = [matched ? "range_matched" : "range_not_matched"];
  return {
    decision: matched ? "matched" : "not_matched",
    confidence: 1,
    reasonCodes,
    evidence: [
      leafEvidence(
        capabilityId,
        canonicalLabel,
        interval.sourceText,
        `${interval.minimum}..${interval.maximum}`,
        matched ? "positive" : "negative",
        1,
        reasonCodes
      )
    ],
    unknown: false
  };
}

type EducationValue = {
  level: EducationLevel;
  sourceText: string;
};

function parseEducationValue(source: SourceValue): EducationValue | "ambiguous" | null {
  const value = normalizeText(source.value);
  if (/(?:博士|博士研究生|ph\.?d\.?|doctorate)/iu.test(value)) {
    return { level: "doctor", sourceText: source.sourceText };
  }
  if (/(?:硕士|硕士研究生|master)/iu.test(value)) {
    return { level: "master", sourceText: source.sourceText };
  }
  if (/(?:本科|学士|bachelor)/iu.test(value)) {
    return { level: "bachelor", sourceText: source.sourceText };
  }
  if (/(?:专科|大专|副学士|associate)/iu.test(value)) {
    return { level: "associate", sourceText: source.sourceText };
  }
  if (/(?:高中|中专|中等专业|职高|high\s*school)/iu.test(value)) {
    return { level: "high_school", sourceText: source.sourceText };
  }
  if (/研究生/u.test(value)) return "ambiguous";
  return null;
}

function labeledEducationValues(candidate: ParsedCandidate, resumeText?: string | null): SourceValue[] {
  const values = Object.entries(candidate.fields)
    .filter(([key, value]) => EDUCATION_FIELD_KEYS.has(normalizeField(key)) && Boolean(value.trim()))
    .map(([key, value]) => ({ sourceText: `${key}：${value.trim()}`, value: value.trim() }));
  const textSources = [candidate.raw, resumeText ?? ""].filter((value) => Boolean(value.trim()));
  const pattern = /(?:最高学历|学历层次|学历|学位|highest\s+education|education\s+level|degree)\s*[:：=]\s*([^,，。;；\n|｜]{1,30})/giu;
  for (const text of textSources) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]?.trim()) {
        values.push({ sourceText: match[0].trim(), value: match[1].trim() });
      }
    }
  }
  return values;
}

function evaluateEducationLevel(
  node: EducationLevelRuleNode,
  candidate: ParsedCandidate,
  resumeText: string | null | undefined
): GenericRuleEvaluation {
  const capabilityId = "education.education_level";
  const canonicalLabel = `最低学历：${EDUCATION_LABEL[node.minimum]}`;
  const sources = labeledEducationValues(candidate, resumeText);
  const parsed = sources.map(parseEducationValue);
  const levels = unique(
    parsed
      .filter((value): value is EducationValue => typeof value === "object" && value !== null)
      .map((value) => value.level)
  ) as EducationLevel[];
  if (parsed.includes("ambiguous") || levels.length > 1) {
    return unknownEvaluation({
      policy: node.unknownPolicy,
      capabilityId,
      canonicalLabel,
      sourceText: sources.map((value) => value.sourceText).join(" / ") || "学历信息冲突",
      normalizedAlias: "ambiguous_education_level",
      reasonCodes: ["education_level_conflicting_or_ambiguous"],
      kind: "ambiguous"
    });
  }
  if (levels.length === 0) {
    return unknownEvaluation({
      policy: node.unknownPolicy,
      capabilityId,
      canonicalLabel,
      sourceText: sources[0]?.sourceText ?? "未提取到明确学历",
      normalizedAlias: "missing_education_level",
      reasonCodes: sources.length > 0 ? ["education_level_unparseable"] : ["field_missing"]
    });
  }
  const level = levels[0]!;
  const matched = EDUCATION_RANK[level] >= EDUCATION_RANK[node.minimum];
  const reasonCodes = [matched ? "education_level_matched" : "education_level_not_matched"];
  const sourceText = parsed.find(
    (value): value is EducationValue => typeof value === "object" && value?.level === level
  )?.sourceText ?? sources[0]!.sourceText;
  return {
    decision: matched ? "matched" : "not_matched",
    confidence: 1,
    reasonCodes,
    evidence: [
      leafEvidence(
        capabilityId,
        canonicalLabel,
        sourceText,
        level,
        matched ? "positive" : "negative",
        1,
        reasonCodes
      )
    ],
    unknown: false
  };
}

export function evaluateGenericRuleNode(
  node: GenericRuleNode,
  candidate: ParsedCandidate,
  ruleText: string,
  resumeText?: string | null
): GenericRuleEvaluation {
  switch (node.type) {
    case "range":
      return evaluateRange(node, candidate, resumeText);
    case "keyword":
      return evaluateKeyword(node, candidate, ruleText, resumeText);
    case "enum":
      return evaluateEnum(node, candidate, ruleText, resumeText);
    case "text":
      return evaluateText(node, candidate, ruleText, resumeText);
    case "education_level":
      return evaluateEducationLevel(node, candidate, resumeText);
  }
}
