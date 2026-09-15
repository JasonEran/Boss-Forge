import { createHash } from "node:crypto";
import { screenExpectedSalary, describeBossFilters, hasBossFilters, planBossRecommendationFilters, sameBossFilterFields, type BossRecommendationFilterPlan, type ParsedCandidate } from "@boss-forge/contracts";
import {
  isLegacyRuleConfig,
  parseRuleConfig,
  type CandidateEducationEvidence,
  type CandidateEvaluationRecord,
  type CompositeRuleConfig,
  type EnglishCredentialCode,
  type EnglishCredentialRuleNode,
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
  TEM8_DICTIONARY_VERSION,
  type InstitutionCatalog,
  type InstitutionCategoryRule,
  type InstitutionRuleEvidence
} from "@boss-forge/rule-engine";
import type { SemanticEvaluation, SemanticRule } from "@boss-forge/semantic-engine";
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
  if (candidate.sourceLocator?.kind === "boss_geek_id") {
    const locatorIdentity = JSON.stringify({
      platform: "boss",
      kind: candidate.sourceLocator.kind,
      value: candidate.sourceLocator.value.trim()
    });
    return createHash("sha256").update(locatorIdentity).digest("hex");
  }
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

const ENGLISH_CREDENTIAL_LABELS: Readonly<Record<EnglishCredentialCode, string>> = {
  tem8: "TEM-8（英语专业八级）",
  cet6: "CET-6（大学英语六级）"
};

function evaluateEnglishCredentialNode(
  node: EnglishCredentialRuleNode,
  ruleText: string
): NodeEvaluation {
  const evaluation = evaluateTem8(ruleText);
  const detected = evaluation.detectedEnglishLevels;
  const accepted = node.accepted.map((code) => ({
    code,
    level: detected
      .filter((item) => item.code === code)
      .sort((left, right) => right.confidence - left.confidence)[0]
  }));
  const confirmed = accepted.filter(
    (item) => item.level && item.level.confidence >= node.minimumConfidence &&
      (item.code !== "tem8" || evaluation.decision === "matched")
  );
  const belowConfidence = accepted.filter(
    (item) => item.level && item.level.confidence < node.minimumConfidence
  );
  const matched =
    node.mode === "all"
      ? confirmed.length === accepted.length
      : confirmed.length > 0;
  const capabilityId = "language.english.credentials";
  const separator = node.mode === "all" ? " 且 " : " 或 ";
  const canonicalLabel = `英语证书：${node.accepted
    .map((code) => ENGLISH_CREDENTIAL_LABELS[code])
    .join(separator)}`;
  if (matched) {
    const reasonCodes = [
      "english_credential_matched",
      `english_credential_mode_${node.mode}`
    ];
    return {
      decision: "matched",
      confidence:
        node.mode === "all"
          ? Math.min(...confirmed.map((item) => item.level!.confidence))
          : Math.max(...confirmed.map((item) => item.level!.confidence)),
      reasonCodes,
      evidence: confirmed.map((item) => ({
        sourceText: item.level!.sourceText,
        normalizedAlias: item.code,
        status: "positive",
        confidence: item.level!.confidence,
        capabilityId,
        canonicalLabel,
        dictionaryVersion: TEM8_DICTIONARY_VERSION,
        reasonCodes
      })),
      englishLevels: detected.map((item) => item.label),
      unknown: false,
      education: [],
      institutionDecisions: []
    };
  }

  const partialAll = node.mode === "all" && confirmed.length > 0;
  const ambiguousTem8 =
    node.accepted.includes("tem8") && evaluation.decision === "ambiguous";
  const explicitlyExcluded = node.accepted.includes("tem8") &&
    evaluation.reasonCodes.includes("negative_context") &&
    (node.mode === "all" || node.accepted.length === 1);
  const unknown = !explicitlyExcluded;
  if (unknown) {
    const policyReason = `unknown_policy_${node.unknownPolicy}`;
    const reasonCodes = unique([
      partialAll ? "english_credential_partial_match" : "english_credential_missing",
      ...(detected.length > 0 ? ["other_english_credential_detected"] : []),
      ...(belowConfidence.length > 0 ? ["below_configured_confidence"] : []),
      ...(ambiguousTem8 ? evaluation.reasonCodes : []),
      `english_credential_mode_${node.mode}`,
      policyReason
    ]);
    const decision: RuntimeNodeDecision =
      node.unknownPolicy === "fail"
        ? "not_matched"
        : node.unknownPolicy === "ignore"
          ? "ignored"
          : ambiguousTem8
            ? "ambiguous"
            : "insufficient";
    return {
      decision,
      confidence: 0,
      reasonCodes,
      evidence: [
        ...confirmed.map((item) => ({
          sourceText: item.level!.sourceText,
          normalizedAlias: item.code,
          status: "positive" as const,
          confidence: item.level!.confidence,
          capabilityId,
          canonicalLabel,
          dictionaryVersion: TEM8_DICTIONARY_VERSION,
          reasonCodes
        })),
        {
          sourceText: `未提取到满足要求的英语证书：${node.accepted
            .filter((code) => !confirmed.some((item) => item.code === code))
            .map((code) => ENGLISH_CREDENTIAL_LABELS[code])
            .join(separator)}`,
          normalizedAlias: "missing_accepted_english_credential",
          status: "ambiguous",
          confidence: 0,
          capabilityId,
          canonicalLabel,
          dictionaryVersion: TEM8_DICTIONARY_VERSION,
          reasonCodes
        }
      ],
      englishLevels: detected.map((item) => item.label),
      unknown: true,
      education: [],
      institutionDecisions: []
    };
  }

  const reasonCodes = [
    "english_credential_not_matched",
    `english_credential_mode_${node.mode}`
  ];
  return {
    decision: "not_matched",
    confidence: Math.max(0.98, ...detected.map((item) => item.confidence)),
    reasonCodes,
    evidence: [
      {
        sourceText:
          evaluation.evidence.filter((item) => item.status === "negative").map((item) => item.sourceText).join(" / ") ||
          `未匹配：${node.accepted.map((code) => ENGLISH_CREDENTIAL_LABELS[code]).join(separator)}`,
        normalizedAlias: "explicit_credential_negative",
        status: "negative",
        confidence: 0.98,
        capabilityId,
        canonicalLabel,
        dictionaryVersion: TEM8_DICTIONARY_VERSION,
        reasonCodes
      }
    ],
    englishLevels: detected.map((item) => item.label),
    unknown: false,
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
    // Keep an explicitly waived graduation check neutral in nested groups and
    // in the BOSS + resume flow. It must not become a missing-evidence rejection.
    const graduationWaived = children.some(child =>
      child.reasonCodes.includes("graduation_metadata_missing_non_blocking"));
    return {
      decision: graduationWaived ? "ignored" : "insufficient",
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

function semanticUnknownDecision(
  policy: UnknownPolicy,
  reasonCodes: string[]
): Pick<NodeEvaluation, "decision" | "unknown" | "reasonCodes"> {
  const policyReason = `unknown_policy_${policy}`;
  return {
    decision:
      policy === "fail"
        ? "not_matched"
        : policy === "ignore"
          ? "ignored"
          : reasonCodes.includes("semantic_conflicting_evidence")
            ? "ambiguous"
            : "insufficient",
    unknown: true,
    reasonCodes: unique([...reasonCodes, policyReason])
  };
}

function semanticNormalizedAlias(evaluation: SemanticEvaluation | undefined): string {
  if (!evaluation || evaluation.normalizedValue === null) return "semantic_unknown";
  const encoded = JSON.stringify(evaluation.normalizedValue);
  return encoded && encoded.length <= 500 ? encoded : "semantic_value";
}

function evaluateSemanticNode(
  node: SemanticRule,
  evaluation: SemanticEvaluation | undefined
): NodeEvaluation {
  const nonActiveResult =
    evaluation !== undefined && evaluation.runtimeMode !== "active";
  if (nonActiveResult) {
    const sourceEvidence = evaluation.evidence.length
      ? evaluation.evidence
      : [evaluation.runtimeMode === "off" ? "岗位智能识别未启用" : "智能识别试运行结果未参与筛选"];
    const status: RecordEvidence["status"] =
      evaluation.result === "matched"
        ? "positive"
        : evaluation.result === "not_matched"
          ? "negative"
          : "ambiguous";
    return {
      decision: "ignored",
      confidence: evaluation.confidence,
      unknown: false,
      reasonCodes: unique([
        ...evaluation.reasonCodes,
        `semantic_${evaluation.runtimeMode}_mode`,
        "semantic_result_not_applied"
      ]),
      evidence: sourceEvidence.map((sourceText) => ({
        sourceText,
        normalizedAlias: semanticNormalizedAlias(evaluation),
        status,
        confidence: evaluation.confidence,
        capabilityId: `semantic.${node.criterionId}`,
        canonicalLabel: node.label,
        dictionaryVersion: evaluation.catalogVersion,
        reasonCodes: unique([
          ...evaluation.reasonCodes,
          `semantic_${evaluation.runtimeMode}_mode`,
          "semantic_result_not_applied"
        ])
      })),
      englishLevels: [],
      education: [],
      institutionDecisions: []
    };
  }
  const belowConfidence =
    evaluation !== undefined && evaluation.confidence < node.minimumConfidence;
  const unresolved =
    !evaluation ||
    evaluation.result === "unknown" ||
    belowConfidence;
  const unresolvedReasons = unique([
    ...(evaluation?.reasonCodes ?? ["semantic_evaluation_missing"]),
    ...(belowConfidence ? ["below_configured_confidence"] : [])
  ]);
  const outcome = unresolved
    ? semanticUnknownDecision(node.unknownPolicy, unresolvedReasons)
    : {
        decision: evaluation.result as Extract<RuntimeNodeDecision, "matched" | "not_matched">,
        unknown: false,
        reasonCodes: unique([
          ...evaluation.reasonCodes,
          `semantic_${evaluation.result}`,
          `semantic_extractor_${evaluation.extractor}`
        ])
      };
  const sourceEvidence = evaluation?.evidence.length
    ? evaluation.evidence
    : ["未提取到可验证的语义证据"];
  const status: RecordEvidence["status"] = unresolved
    ? "ambiguous"
    : evaluation!.result === "matched"
      ? "positive"
      : "negative";
  const version = [
    evaluation?.catalogVersion ?? "semantic-catalog-unknown",
    evaluation?.modelVersion ?? evaluation?.extractor ?? "none",
    evaluation?.promptVersion ?? "prompt-unknown",
    evaluation?.rubricVersion ?? "no-rubric"
  ].join("/");
  return {
    decision: outcome.decision,
    confidence: unresolved ? 0 : evaluation!.confidence,
    reasonCodes: outcome.reasonCodes,
    evidence: sourceEvidence.map((sourceText) => ({
      sourceText,
      normalizedAlias: semanticNormalizedAlias(evaluation),
      status,
      confidence: unresolved ? 0 : evaluation!.confidence,
      capabilityId: `semantic.${node.criterionId}`,
      canonicalLabel: node.label,
      dictionaryVersion: version,
      reasonCodes: outcome.reasonCodes
    })),
    englishLevels: [],
    unknown: outcome.unknown,
    education: [],
    institutionDecisions: []
  };
}

export function collectSemanticRules(ruleConfig: RuleConfig): SemanticRule[] {
  const config = parseRuleConfig(ruleConfig);
  if (isLegacyRuleConfig(config)) return [];
  const rules: SemanticRule[] = [];
  const visit = (node: RuleNode): void => {
    if (isGroupNode(node)) {
      node.children.forEach(visit);
      return;
    }
    if (node.type === "semantic") rules.push(node);
  };
  visit(config.root);
  return rules;
}

function evaluateNode(
  node: RuleNode,
  candidate: ParsedCandidate,
  ruleText: string,
  resumeText: string | null | undefined,
  catalog: InstitutionCatalog | undefined,
  semanticById: ReadonlyMap<string, SemanticEvaluation>
): NodeEvaluation {
  // Gender is not a job qualification. Preserve the historical rule/evidence
  // for explanation, but never let it approve, reject, or stall a candidate.
  if (!isGroupNode(node) && node.type === "enum" && node.field === "gender") {
    return withEnglishLevels({
      decision: "ignored", confidence: 0, unknown: false,
      reasonCodes: ["non_qualification_condition_ignored"],
      evidence: [{ capabilityId: "enum.gender", canonicalLabel: "性别（不参与自动筛选）",
        dictionaryVersion: "qualification-policy-2026.09.07", sourceText: "自动筛选只使用岗位相关资格，性别不参与通过或淘汰判断。",
        normalizedAlias: "not_applicable", status: "ambiguous", confidence: 0,
        reasonCodes: ["non_qualification_condition_ignored"] }]
    });
  }
  if (isGroupNode(node)) {
    return aggregateGroup(
      node,
      node.children.map((child) =>
        evaluateNode(child, candidate, ruleText, resumeText, catalog, semanticById)
      )
    );
  }
  if (node.type === "tem8" || node.type === "capability") {
    return evaluateTem8Node(node, ruleText);
  }
  if (node.type === "english_credential") {
    return evaluateEnglishCredentialNode(node, ruleText);
  }
  if (node.type === "institution_category") {
    if (!catalog) {
      throw new Error("Institution rule requires a locked catalog snapshot.");
    }
    return evaluateInstitutionNode(node, candidate, resumeText, catalog);
  }
  if (node.type === "semantic") {
    return evaluateSemanticNode(node, semanticById.get(node.criterionId));
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
    ...(candidate.sourceLocator ? { sourceLocator: candidate.sourceLocator } : {}),
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
  resumeText?: string | null,
  semanticEvaluations: SemanticEvaluation[] = [],
  appliedBossFilters?: BossRecommendationFilterPlan | null
): CandidateEvaluationRecord {
  let evaluation = evaluateNode(
    config.root,
    candidate,
    ruleText,
    resumeText,
    config.institutionCatalog,
    new Map(semanticEvaluations.map((item) => [item.criterionId, item]))
  );
  if (config.screeningFlow === "boss_then_resume") {
    const planned = planBossRecommendationFilters(config);
    if (hasBossFilters(planned.fields)) {
      const verified = candidate.source === "recommend" && appliedBossFilters != null && sameBossFilterFields(planned.fields, appliedBossFilters.fields);
      const reason = verified ? "boss_official_filters_applied" : "boss_official_filters_unverified";
      const official: NodeEvaluation = {
        decision: verified ? "matched" : "insufficient", confidence: verified ? 1 : 0,
        reasonCodes: [reason], englishLevels: [], unknown: !verified, education: [], institutionDecisions: [],
        evidence: [{ capabilityId: "boss.official_filters", canonicalLabel: "BOSS 官方筛选", dictionaryVersion: "boss-filter-v1",
          sourceText: verified ? `本次名单由 BOSS 按以下条件筛选：${describeBossFilters(planned)}` : "本次名单没有与当前规则一致的 BOSS 官方筛选记录，请重新采集。",
          normalizedAlias: describeBossFilters(planned), status: verified ? "positive" : "ambiguous", confidence: verified ? 1 : 0, reasonCodes: [reason] }]
      };
      evaluation = config.root.children.length === 0 ? official : aggregateGroup({ operator: "AND", children: [] }, [official, evaluation]);
    }
    // A completed résumé must positively support the required qualifications.
    // Collection cards and unverified provider context remain pending evidence.
    if (resumeText?.trim() && ['ambiguous', 'insufficient'].includes(evaluation.decision) &&
      !evaluation.reasonCodes.includes('boss_official_filters_unverified')) {
      evaluation = { ...evaluation, decision: 'not_matched',
        reasonCodes: unique([...evaluation.reasonCodes, 'required_resume_evidence_missing']),
        evidence: [...evaluation.evidence, {
          capabilityId: 'resume.evidence_requirement', canonicalLabel: '简历证据要求', dictionaryVersion: 'resume-evidence-v1',
          sourceText: '完整简历已读取，但未识别到满足岗位要求的明确证据，按证据不足判为未通过。',
          normalizedAlias: '缺少必需的简历证据', status: 'negative', confidence: 0,
          reasonCodes: ['required_resume_evidence_missing'],
        }],
      };
    }
  }
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
    ...(candidate.sourceLocator ? { sourceLocator: candidate.sourceLocator } : {}),
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
    dictionaryVersion:
      config.institutionCatalog?.version ?? `rule-schema-${config.schemaVersion}`,
    currentEnglishLevel: evaluation.englishLevels.join(" / ") || null,
    reasonCodes: evaluation.reasonCodes,
    ...(institutionDecision ? { institutionDecision } : {}),
    ...(institutionSummary ? { institutionSummary } : {}),
    ...(config.institutionCatalog
      ? { institutionCatalogVersion: config.institutionCatalog.version }
      : {}),
    ...(education.length > 0 ? { education } : {}),
    ...(semanticEvaluations.length > 0 ? { semanticEvaluations } : {}),
    evidence: evaluation.evidence
  };
}

export function evaluateCandidate(
  candidate: ParsedCandidate,
  ruleConfig: RuleConfig,
  resumeText?: string | null,
  semanticEvaluations: SemanticEvaluation[] = [],
  appliedBossFilters?: BossRecommendationFilterPlan | null
): CandidateEvaluationRecord {
  // Revalidate persisted snapshots so direct database ingestion cannot bypass the API validator.
  const config = parseRuleConfig(ruleConfig);
  const ruleText = fullRuleText(candidate, resumeText);
  if (isLegacyRuleConfig(config)) return legacyEvaluation(candidate, config, ruleText);
  const record = compositeEvaluation(candidate, config, ruleText, resumeText, semanticEvaluations, appliedBossFilters);
  if (config.root.children.length === 0 && config.recruitment && !hasBossFilters(planBossRecommendationFilters(config).fields)) {
    record.decision = "matched";
    record.confidence = 1;
  }
  const ceiling = config.recruitment?.salaryCeilingYuan;
  if (ceiling != null) {
    const salary = screenExpectedSalary(candidate.fields, ceiling);
    record.salaryScreening = salary;
    const reason = salary.status === "above_budget" ? "salary_above_ceiling" : salary.status === "unknown" ? "salary_expectation_unknown" : "salary_within_ceiling";
    record.reasonCodes.push(reason);
    record.evidence.push({
      capabilityId: "recruitment.salary", canonicalLabel: "期望薪资上限", dictionaryVersion: "salary-upper-v1",
      sourceText: `期望薪资：${salary.expected || "未提供"}；岗位月薪上限：${ceiling} 元。` + (salary.status === "above_budget" ? "期望区间最高值超出预算，直接过滤，无需打开简历。" : salary.status === "unknown" ? "无法确定期望月薪上限，需人工核实。" : "期望区间最高值在预算内。"),
      normalizedAlias: salary.expected, status: salary.status === "above_budget" ? "negative" : salary.status === "unknown" ? "ambiguous" : "positive",
      confidence: salary.status === "unknown" ? 0 : 1, reasonCodes: [reason],
    });
    if (salary.status === "above_budget") { record.decision = "not_matched"; record.confidence = 1; }
    else if (salary.status === "unknown" && record.decision === "matched") { record.decision = "insufficient"; record.confidence = 0; }
  }
  return record;
}
