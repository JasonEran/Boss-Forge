import { createHash } from "node:crypto";
import type { ParsedCandidate } from "@boss-forge/contracts";
import {
  isLegacyRuleConfig,
  parseRuleConfig,
  type CandidateEducationEvidence,
  type CandidateEvaluationRecord,
  type CompositeRuleConfig,
  type RuleConfig,
  type RuleGroupNode,
  type RuleNode,
  type Tem8CapabilityRuleNode,
  type Tem8RuleNode,
  type UnknownPolicy
} from "@boss-forge/data";
import {
  evaluateInstitutionCategoryRule,
  evaluateTem8,
  type InstitutionCatalog,
  type InstitutionCategoryRule,
  type InstitutionRuleEvidence
} from "@boss-forge/rule-engine";
import { extractEducationExperiences } from "./education.js";
import {
  evaluateGenericRuleNode,
  type GenericRuleEvaluation,
  type RuntimeNodeDecision
} from "./generic-rules.js";

export { extractEducationExperiences } from "./education.js";

type RecordEvidence = CandidateEvaluationRecord["evidence"][number];
type InstitutionDecision = NonNullable<CandidateEvaluationRecord["institutionDecision"]>;

type NodeEvaluation = {
  decision: RuntimeNodeDecision;
  confidence: number;
  reasonCodes: string[];
  evidence: RecordEvidence[];
  englishLevels: string[];
  unknown: boolean;
  education: CandidateEducationEvidence[];
  institutionDecisions: InstitutionDecision[];
};

function normalizedFields(fields: Record<string, string>): Array<[string, string]> {
  return Object.entries(fields)
    .map(([key, value]) => [key.trim().toLocaleLowerCase("zh-CN"), value.trim()] as [string, string])
    .sort(([left], [right]) => left.localeCompare(right));
}

const MUTABLE_LIST_FIELD_NAMES = new Set([
  "期望",
  "薪资",
  "标签",
  "boss标签",
  "平台标签",
  "院校标签",
  "学校标签",
  "boss平台标签"
]);

function identityFields(fields: Record<string, string>): Array<[string, string]> {
  const normalized = normalizedFields(fields);
  const stable = normalized.filter(([key]) => !MUTABLE_LIST_FIELD_NAMES.has(key));
  return stable.length > 0 ? stable : normalized;
}

export function candidateFingerprint(candidate: ParsedCandidate): string {
  const identity = JSON.stringify({
    name: candidate.name.trim().toLocaleLowerCase("zh-CN"),
    fields: identityFields(candidate.fields)
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueEducation(values: CandidateEducationEvidence[]): CandidateEducationEvidence[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify([
      value.stage,
      value.institutionRaw,
      value.degree ?? "",
      value.major ?? "",
      value.campusOrCollege ?? ""
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fullRuleText(candidate: ParsedCandidate, resumeText?: string | null): string {
  const listText = candidateRuleText(candidate);
  return [listText, resumeText?.trim()].filter(Boolean).join("。完整简历：");
}

function tem8Minimum(node: Tem8RuleNode | Tem8CapabilityRuleNode): number {
  return node.minimumConfidence ?? 0;
}

function evaluateTem8Node(
  node: Tem8RuleNode | Tem8CapabilityRuleNode,
  ruleText: string
): NodeEvaluation {
  const evaluation = evaluateTem8(ruleText);
  const belowConfiguredConfidence =
    evaluation.decision === "matched" && evaluation.confidence < tem8Minimum(node);
  const unknown =
    belowConfiguredConfidence ||
    evaluation.decision === "ambiguous" ||
    evaluation.decision === "insufficient";
  const policy: UnknownPolicy = node.unknownPolicy ?? "manual_review";
  const policyReason = `unknown_policy_${policy}`;
  let decision: RuntimeNodeDecision = belowConfiguredConfidence
    ? "ambiguous"
    : evaluation.decision;
  if (unknown && policy === "fail") decision = "not_matched";
  if (unknown && policy === "ignore") decision = "ignored";
  const reasonCodes = unique([
    ...evaluation.reasonCodes,
    ...(belowConfiguredConfidence ? ["below_configured_confidence"] : []),
    ...(unknown ? [policyReason] : [])
  ]);
  const evidence = evaluation.evidence.map((item) => ({
    ...item,
    capabilityId: evaluation.capabilityId,
    canonicalLabel: evaluation.canonicalLabel,
    dictionaryVersion: evaluation.dictionaryVersion,
    reasonCodes
  }));
  if (evidence.length === 0) {
    evidence.push({
      sourceText: "未提取到明确 TEM-8 证据",
      normalizedAlias: "missing_tem8_evidence",
      status: "ambiguous",
      confidence: 0,
      capabilityId: evaluation.capabilityId,
      canonicalLabel: evaluation.canonicalLabel,
      dictionaryVersion: evaluation.dictionaryVersion,
      reasonCodes
    });
  }
  return {
    decision,
    confidence: evaluation.confidence,
    reasonCodes,
    evidence,
    englishLevels: evaluation.detectedEnglishLevels.map((item) => item.label),
    unknown,
    education: [],
    institutionDecisions: []
  };
}

function institutionCapabilityId(rule: InstitutionCategoryRule): string {
  return `education.institution.${rule.educationStage}.${rule.categories.join("+")}`;
}

function institutionCanonicalLabel(rule: InstitutionCategoryRule): string {
  return `院校类别（${rule.educationStage}）：${rule.categories.join(
    rule.mode === "all" ? " AND " : " OR "
  )}`;
}

function institutionEvidenceStatus(
  evidence: InstitutionRuleEvidence
): RecordEvidence["status"] {
  if (evidence.result === "matched") return "positive";
  if (evidence.result === "not_matched") return "negative";
  return "ambiguous";
}

function institutionManualDecision(
  reasonCodes: readonly string[]
): Extract<RuntimeNodeDecision, "ambiguous" | "insufficient"> {
  const ambiguousReasons = new Set([
    "conflicting_education_stage",
    "ambiguous_institution",
    "unverified_campus_or_college",
    "conflicting_target_experiences",
    "unconfirmed_awarding_institution",
    "catalog_version_mismatch",
    "catalog_not_published",
    "catalog_validation_failed"
  ]);
  return reasonCodes.some((reason) => ambiguousReasons.has(reason)) ? "ambiguous" : "insufficient";
}

function institutionEvidence(
  rule: InstitutionCategoryRule,
  evidence: InstitutionRuleEvidence,
  reasonCodes: string[]
): RecordEvidence {
  const capabilityId = institutionCapabilityId(rule);
  const canonicalLabel = institutionCanonicalLabel(rule);
  return {
    sourceText: evidence.sourceText?.trim() || evidence.institutionRaw || "未提取到明确院校文本",
    normalizedAlias:
      evidence.standardInstitution?.trim() ||
      evidence.normalizedInstitution ||
      "unresolved_institution",
    status: institutionEvidenceStatus(evidence),
    confidence: evidence.confidence,
    capabilityId,
    canonicalLabel,
    dictionaryVersion: evidence.catalogVersion,
    reasonCodes: unique([...reasonCodes, ...evidence.reasons])
  };
}

function evaluateInstitutionNode(
  rule: InstitutionCategoryRule,
  candidate: ParsedCandidate,
  resumeText: string | null | undefined,
  catalog: InstitutionCatalog
): NodeEvaluation {
  const experiences = extractEducationExperiences(candidate, resumeText);
  const evaluation = evaluateInstitutionCategoryRule(rule, experiences, catalog);
  const experienceById = new Map(
    experiences.filter((item) => item.id).map((item) => [item.id!, item])
  );
  let decision: RuntimeNodeDecision;
  switch (evaluation.decision) {
    case "matched":
      decision = "matched";
      break;
    case "not_matched":
      decision = "not_matched";
      break;
    case "manual_review":
      decision = institutionManualDecision(evaluation.reasonCodes);
      break;
    case "ignored":
      decision = "ignored";
      break;
  }
  const reasonCodes = evaluation.reasonCodes;
  const evidence = evaluation.evidence.map((item) =>
    institutionEvidence(rule, item, reasonCodes)
  );
  if (evidence.length === 0) {
    evidence.push({
      sourceText: "未从候选字段或 OCR 简历中提取到带显式标签的教育经历",
      normalizedAlias: "no_explicit_education_evidence",
      status: "ambiguous",
      confidence: 0,
      capabilityId: institutionCapabilityId(rule),
      canonicalLabel: institutionCanonicalLabel(rule),
      dictionaryVersion: catalog.version,
      reasonCodes
    });
  }
  const relevantConfidence = evaluation.evidence
    .filter((item) => item.result === "matched" || item.result === "not_matched")
    .map((item) => item.confidence);
  const education = evaluation.evidence
    .filter((item) => item.result !== "excluded" && item.institutionRaw.trim())
    .map((item): CandidateEducationEvidence => {
      const source = item.experienceId ? experienceById.get(item.experienceId) : undefined;
      return {
        stage:
          item.educationStage === "associate"
            ? "college"
            : item.educationStage ?? "other",
        institutionRaw: item.institutionRaw,
        ...(source?.degree || source?.qualification
          ? { degree: source.degree ?? source.qualification }
          : {}),
        ...(item.major ? { major: item.major } : {}),
        ...(item.campusOrCollege ? { campusOrCollege: item.campusOrCollege } : {}),
        ...(source?.startAt ? { startAt: source.startAt } : {}),
        ...(source?.endAt ? { endAt: source.endAt } : {}),
        categorySnapshot: [...item.categoriesSnapshot],
        confidence: item.confidence,
        ...(item.sourceText ? { evidenceText: item.sourceText } : {}),
        ...(item.artifactRef ? { artifactReference: item.artifactRef } : {})
      };
    });
  return {
    decision,
    confidence: relevantConfidence.length > 0 ? Math.max(...relevantConfidence) : 0,
    reasonCodes,
    evidence,
    englishLevels: [],
    unknown:
      evaluation.decision === "manual_review" ||
      evaluation.decision === "ignored" ||
      evaluation.reasonCodes.includes("unknown_policy_fail"),
    education: uniqueEducation(education),
    institutionDecisions: [
      evaluation.decision === "matched"
        ? "matched"
        : evaluation.decision === "not_matched"
          ? "not_matched"
          : "unknown"
    ]
  };
}

function isGroupNode(node: RuleNode): node is RuleGroupNode {
  return "children" in node;
}

function groupMode(node: RuleGroupNode): "all" | "any" | "not" {
  if ("operator" in node) {
    if (node.operator === "NOT") return "not";
    return node.operator === "AND" ? "all" : "any";
  }
  return node.type;
}

function aggregateGroup(node: RuleGroupNode, children: NodeEvaluation[]): NodeEvaluation {
  const mode = groupMode(node);
  if (mode === "not") {
    const child = children[0]!;
    let decision = child.decision;
    let reason = "composite_not_unknown_not_inverted";
    if (!child.unknown && child.decision === "matched") {
      decision = "not_matched";
      reason = "composite_not_not_matched";
    } else if (!child.unknown && child.decision === "not_matched") {
      decision = "matched";
      reason = "composite_not_matched";
    } else if (child.decision === "ignored") {
      reason = "composite_not_ignored";
    }
    return {
      ...child,
      decision,
      reasonCodes: unique([reason, ...child.reasonCodes])
    };
  }

  const active = children.filter((child) => child.decision !== "ignored");
  if (active.length === 0) {
    return {
      decision: "insufficient",
      confidence: 0,
      reasonCodes: unique([
        `composite_${mode}_all_children_ignored`,
        ...children.flatMap((child) => child.reasonCodes)
      ]),
      evidence: children.flatMap((child) => child.evidence),
      englishLevels: unique(children.flatMap((child) => child.englishLevels)),
      unknown: true,
      education: uniqueEducation(children.flatMap((child) => child.education)),
      institutionDecisions: children.flatMap((child) => child.institutionDecisions)
    };
  }

  const decisions = active.map((child) => child.decision);
  let decision: RuntimeNodeDecision;
  if (mode === "all") {
    decision = decisions.includes("not_matched")
      ? "not_matched"
      : decisions.includes("ambiguous")
        ? "ambiguous"
        : decisions.includes("insufficient")
          ? "insufficient"
          : "matched";
  } else {
    decision = decisions.includes("matched")
      ? "matched"
      : decisions.includes("ambiguous")
        ? "ambiguous"
        : decisions.includes("insufficient")
          ? "insufficient"
          : "not_matched";
  }

  const confidenceValues = active
    .filter((child) => child.decision === decision)
    .map((child) => child.confidence);
  const confidence =
    confidenceValues.length === 0
      ? 0
      : decision === "matched" && mode === "all"
        ? Math.min(...confidenceValues)
        : Math.max(...confidenceValues);
  const unknown =
    mode === "all"
      ? decision === "matched"
        ? false
        : decision === "not_matched"
          ? !active.some((child) => child.decision === "not_matched" && !child.unknown)
          : true
      : decision === "matched"
        ? false
        : decision === "not_matched"
          ? active.some((child) => child.unknown)
          : true;
  return {
    decision,
    confidence,
    reasonCodes: unique([
      `composite_${mode}_${decision}`,
      ...children.flatMap((child) => child.reasonCodes)
    ]),
    evidence: children.flatMap((child) => child.evidence),
    englishLevels: unique(children.flatMap((child) => child.englishLevels)),
    unknown,
    education: uniqueEducation(children.flatMap((child) => child.education)),
    institutionDecisions: children.flatMap((child) => child.institutionDecisions)
  };
}

function withEnglishLevels(evaluation: GenericRuleEvaluation): NodeEvaluation {
  return {
    ...evaluation,
    englishLevels: [],
    education: [],
    institutionDecisions: []
  };
}

function evaluateNode(
  node: RuleNode,
  candidate: ParsedCandidate,
  ruleText: string,
  resumeText: string | null | undefined,
  catalog: InstitutionCatalog | undefined
): NodeEvaluation {
  if (isGroupNode(node)) {
    return aggregateGroup(
      node,
      node.children.map((child) => evaluateNode(child, candidate, ruleText, resumeText, catalog))
    );
  }
  if (node.type === "tem8" || node.type === "capability") {
    return evaluateTem8Node(node, ruleText);
  }
  if (node.type === "institution_category") {
    if (!catalog) {
      throw new Error("Institution rule requires a locked catalog snapshot.");
    }
    return evaluateInstitutionNode(node, candidate, resumeText, catalog);
  }
  return withEnglishLevels(evaluateGenericRuleNode(node, candidate, ruleText, resumeText));
}

function legacyEvaluation(
  candidate: ParsedCandidate,
  config: Extract<RuleConfig, { requiredCapabilities: unknown }>,
  ruleText: string
): CandidateEvaluationRecord {
  const tem8Requirement = config.requiredCapabilities.find(
    (item) => item.capability === "tem8"
  );
  if (!tem8Requirement) throw new Error("M1 requires a TEM8 capability rule.");
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
    currentEnglishLevel:
      evaluation.detectedEnglishLevels.map((item) => item.label).join(" / ") || null,
    reasonCodes: belowConfiguredConfidence
      ? [...evaluation.reasonCodes, "below_configured_confidence"]
      : evaluation.reasonCodes,
    // Do not add composite metadata to legacy output; old repository/tests remain byte-compatible.
    evidence: evaluation.evidence
  };
}

function compositeEvaluation(
  candidate: ParsedCandidate,
  config: CompositeRuleConfig,
  ruleText: string,
  resumeText?: string | null
): CandidateEvaluationRecord {
  const evaluation = evaluateNode(
    config.root,
    candidate,
    ruleText,
    resumeText,
    config.institutionCatalog
  );
  const education = uniqueEducation(evaluation.education);
  const institutionDecision: InstitutionDecision | undefined =
    evaluation.institutionDecisions.length === 0
      ? undefined
      : evaluation.institutionDecisions.includes("unknown")
        ? "unknown"
        : evaluation.institutionDecisions.every((item) => item === "matched")
          ? "matched"
          : "not_matched";
  const institutionSummary = unique(
    education.map((item) => {
      const categories = item.categorySnapshot.length
        ? `（${item.categorySnapshot.join("/")}）`
        : "";
      return `${item.stage}: ${item.institutionRaw}${categories}`;
    })
  )
    .slice(0, 5)
    .join("；");
  return {
    sourceReference: `${candidate.source}:${candidate.index}:${candidate.name}`,
    source: candidate.source,
    displayName: candidate.name,
    fingerprint: candidateFingerprint(candidate),
    rawFields: candidate.fields,
    sourceEvidence: candidate.evidence,
    rawText: ruleText,
    decision: evaluation.decision === "ignored" ? "insufficient" : evaluation.decision,
    confidence: evaluation.confidence,
    capabilityId: "rule.composite",
    canonicalLabel: config.name ?? "组合筛选规则",
    dictionaryVersion: config.institutionCatalog?.version ?? "rule-schema-1.0",
    currentEnglishLevel: evaluation.englishLevels.join(" / ") || null,
    reasonCodes: evaluation.reasonCodes,
    ...(institutionDecision ? { institutionDecision } : {}),
    ...(institutionSummary ? { institutionSummary } : {}),
    ...(config.institutionCatalog
      ? { institutionCatalogVersion: config.institutionCatalog.version }
      : {}),
    ...(education.length > 0 ? { education } : {}),
    evidence: evaluation.evidence
  };
}

export function evaluateCandidate(
  candidate: ParsedCandidate,
  ruleConfig: RuleConfig,
  resumeText?: string | null
): CandidateEvaluationRecord {
  // Revalidate persisted snapshots so Odoo or database ingestion cannot bypass the API validator.
  const config = parseRuleConfig(ruleConfig);
  const ruleText = fullRuleText(candidate, resumeText);
  if (isLegacyRuleConfig(config)) return legacyEvaluation(candidate, config, ruleText);
  return compositeEvaluation(candidate, config, ruleText, resumeText);
}
