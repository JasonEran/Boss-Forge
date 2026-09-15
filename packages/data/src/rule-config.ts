import {
  loadInstitutionCatalog,
  validateInstitutionCategoryRule,
  type InstitutionCatalog,
  type InstitutionCategoryRule
} from "@boss-forge/rule-engine";
import type { SemanticRule } from "@boss-forge/semantic-engine";
import { recruitmentConfigSchema, bossRecommendationFilterConfigSchema, hasBossFilters, isBossManagedResumeNode } from "@boss-forge/contracts";
import type {
  CompositeRuleConfig,
  EducationLevel,
  EducationLevelRuleNode,
  EnglishCredentialCode,
  EnglishCredentialRuleNode,
  EnumRuleNode,
  GraduateStatusCode,
  GraduateStatusRuleNode,
  KeywordRuleNode,
  LegacyRuleConfig,
  RangeRuleNode,
  RuleConfig,
  RuleGroupNode,
  RuleNode,
  Tem8CapabilityRuleNode,
  Tem8RuleNode,
  TextRuleNode,
  UnknownPolicy
} from "./types.js";

type JsonObject = Record<string, unknown>;

const MAX_RULE_DEPTH = 12;
const MAX_RULE_NODES = 100;
const MAX_RULE_VALUES = 50;
const MAX_FIELD_LENGTH = 100;
const MAX_VALUE_LENGTH = 500;
const UNKNOWN_POLICIES = new Set<UnknownPolicy>(["manual_review", "fail", "ignore"]);
const EDUCATION_LEVELS = new Set<EducationLevel>([
  "high_school",
  "associate",
  "bachelor",
  "master",
  "doctor"
]);
const ENGLISH_CREDENTIALS = new Set<EnglishCredentialCode>(["tem8", "cet6"]);
const GRADUATE_STATUSES = new Set<GraduateStatusCode>([
  "current_or_upcoming_graduate",
  "experienced"
]);
const CATALOG_KEYS = new Set([
  "schemaVersion",
  "version",
  "status",
  "source",
  "importedBy",
  "reviewedBy",
  "publishedAt",
  "changeSummary",
  "institutions",
  "contentHash"
]);
const CATALOG_SOURCE_KEYS = new Set(["name", "asOfDate", "url"]);
const INSTITUTION_KEYS = new Set([
  "id",
  "standardName",
  "countryOrRegion",
  "kind",
  "categories",
  "aliases",
  "doubleFirstClassDisciplines",
  "validFrom",
  "validTo"
]);
const ALIAS_KEYS = new Set(["id", "value", "kind", "confidence"]);

export class RuleConfigValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "RuleConfigValidationError";
    this.issues = issues;
  }
}

function record(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuleConfigValidationError([`${path} must be an object.`]);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RuleConfigValidationError([
      `${path} contains unsupported field(s): ${unknown.sort().join(", ")}.`
    ]);
  }
}

function confidence(value: unknown, path: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RuleConfigValidationError([`${path} must be between 0 and 1.`]);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string, maximum = MAX_VALUE_LENGTH): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuleConfigValidationError([`${path} must be a non-empty string.`]);
  }
  const parsed = value.trim();
  if (parsed.length > maximum) {
    throw new RuleConfigValidationError([`${path} must not exceed ${maximum} characters.`]);
  }
  return parsed;
}

function parseUnknownPolicy(value: unknown, path: string): UnknownPolicy {
  if (typeof value !== "string" || !UNKNOWN_POLICIES.has(value as UnknownPolicy)) {
    throw new RuleConfigValidationError([
      `${path} must be manual_review, fail, or ignore.`
    ]);
  }
  return value as UnknownPolicy;
}

function parseValues(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuleConfigValidationError([`${path} must be a non-empty array.`]);
  }
  if (value.length > MAX_RULE_VALUES) {
    throw new RuleConfigValidationError([
      `${path} must not contain more than ${MAX_RULE_VALUES} values.`
    ]);
  }
  const parsed = value.map((item, index) =>
    nonEmptyString(item, `${path}[${index}]`)
  );
  const normalized = parsed.map((item) => item.normalize("NFKC").toLocaleLowerCase("zh-CN"));
  if (new Set(normalized).size !== normalized.length) {
    throw new RuleConfigValidationError([`${path} contains duplicate normalized values.`]);
  }
  return parsed;
}

function mode(value: unknown, path: string): "any" | "all" {
  if (value !== "any" && value !== "all") {
    throw new RuleConfigValidationError([`${path} must be any or all.`]);
  }
  return value;
}

function textMatch(value: unknown, path: string): "exact" | "contains" {
  if (value !== "exact" && value !== "contains") {
    throw new RuleConfigValidationError([`${path} must be exact or contains.`]);
  }
  return value;
}

function assertStrictCatalogShape(value: unknown): void {
  const catalog = record(value, "config.institutionCatalog");
  exactKeys(catalog, CATALOG_KEYS, "config.institutionCatalog");
  const source = record(catalog.source, "config.institutionCatalog.source");
  exactKeys(source, CATALOG_SOURCE_KEYS, "config.institutionCatalog.source");
  if (!Array.isArray(catalog.institutions)) {
    throw new RuleConfigValidationError([
      "config.institutionCatalog.institutions must be an array."
    ]);
  }
  catalog.institutions.forEach((item, institutionIndex) => {
    const path = `config.institutionCatalog.institutions[${institutionIndex}]`;
    const institution = record(item, path);
    exactKeys(institution, INSTITUTION_KEYS, path);
    if (!Array.isArray(institution.aliases)) {
      throw new RuleConfigValidationError([`${path}.aliases must be an array.`]);
    }
    institution.aliases.forEach((aliasValue, aliasIndex) => {
      const aliasPath = `${path}.aliases[${aliasIndex}]`;
      const alias = record(aliasValue, aliasPath);
      exactKeys(alias, ALIAS_KEYS, aliasPath);
    });
  });
}

function parseLegacy(value: JsonObject): LegacyRuleConfig {
  exactKeys(value, new Set(["requiredCapabilities"]), "config");
  if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length === 0) {
    throw new RuleConfigValidationError([
      "config.requiredCapabilities must contain at least one capability."
    ]);
  }
  const seen = new Set<string>();
  const requiredCapabilities = value.requiredCapabilities.map((item, index) => {
    const path = `config.requiredCapabilities[${index}]`;
    const capability = record(item, path);
    exactKeys(capability, new Set(["capability", "minimumConfidence"]), path);
    if (capability.capability !== "tem8") {
      throw new RuleConfigValidationError([`${path}.capability must be tem8.`]);
    }
    if (seen.has("tem8")) {
      throw new RuleConfigValidationError(["config contains a duplicate tem8 capability."]);
    }
    seen.add("tem8");
    return {
      capability: "tem8" as const,
      minimumConfidence: confidence(capability.minimumConfidence, `${path}.minimumConfidence`)
    };
  });
  return { requiredCapabilities };
}

type ParseContext = {
  nodeCount: number;
  institutionLeaves: InstitutionCategoryRule[];
  semanticCriterionIds: Set<string>;
  schemaVersion: "1.0" | "1.1";
  splitFlow?: boolean;
  allowEmptyRoot?: boolean;
};

function parseSemanticAliases(
  value: unknown,
  expectedValues: string[],
  path: string
): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  const aliases = record(value, path);
  const expected = new Set(expectedValues);
  const unsupported = Object.keys(aliases).filter((key) => !expected.has(key));
  if (unsupported.length > 0) {
    throw new RuleConfigValidationError([
      `${path} contains canonical values not present in expectedValues: ${unsupported.join(", ")}.`
    ]);
  }
  const parsed: Record<string, string[]> = {};
  for (const [canonical, rawAliases] of Object.entries(aliases)) {
    parsed[canonical] = parseValues(rawAliases, `${path}.${canonical}`);
  }
  return parsed;
}

function parseNode(value: unknown, path: string, depth: number, context: ParseContext): RuleNode {
  if (depth > MAX_RULE_DEPTH) {
    throw new RuleConfigValidationError([`Rule depth exceeds ${MAX_RULE_DEPTH}.`]);
  }
  context.nodeCount += 1;
  if (context.nodeCount > MAX_RULE_NODES) {
    throw new RuleConfigValidationError([`Rule contains more than ${MAX_RULE_NODES} nodes.`]);
  }

  const node = record(value, path);
  if (context.splitFlow && isBossManagedResumeNode(node)) {
    throw new RuleConfigValidationError(["学历、工作经验、院校和专业请在第一步 BOSS 官方筛选中设置，第二步无需重复核验。"]);
  }
  if (node.operator === "AND" || node.operator === "OR" || node.operator === "NOT") {
    exactKeys(node, new Set(["operator", "children"]), path);
    if (!Array.isArray(node.children) || (node.children.length === 0 && !(context.allowEmptyRoot && depth === 0 && node.operator === "AND"))) {
      throw new RuleConfigValidationError([`${path}.children must not be empty.`]);
    }
    if (node.operator === "NOT" && node.children.length !== 1) {
      throw new RuleConfigValidationError([`${path}.children must contain exactly one node for NOT.`]);
    }
    return {
      operator: node.operator,
      children: node.children.map((child, index) =>
        parseNode(child, `${path}.children[${index}]`, depth + 1, context)
      )
    } satisfies RuleGroupNode;
  }

  if (node.type === "all" || node.type === "any") {
    exactKeys(node, new Set(["type", "children"]), path);
    if (!Array.isArray(node.children) || node.children.length === 0) {
      throw new RuleConfigValidationError([`${path}.children must not be empty.`]);
    }
    return {
      type: node.type,
      children: node.children.map((child, index) =>
        parseNode(child, `${path}.children[${index}]`, depth + 1, context)
      )
    } satisfies RuleGroupNode;
  }

  if (node.type === "tem8") {
    exactKeys(node, new Set(["type", "minimumConfidence", "unknownPolicy"]), path);
    return {
      type: "tem8",
      minimumConfidence: confidence(node.minimumConfidence, `${path}.minimumConfidence`),
      ...(node.unknownPolicy === undefined
        ? {}
        : { unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`) })
    } satisfies Tem8RuleNode;
  }

  if (node.type === "capability") {
    exactKeys(
      node,
      new Set(["type", "capability", "match", "minimumConfidence", "unknownPolicy"]),
      path
    );
    if (node.capability !== "tem8" || node.match !== "confirmed") {
      throw new RuleConfigValidationError([
        `${path} supports only the confirmed tem8 capability.`
      ]);
    }
    return {
      type: "capability",
      capability: "tem8",
      match: "confirmed",
      minimumConfidence: confidence(node.minimumConfidence, `${path}.minimumConfidence`, 0),
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    } satisfies Tem8CapabilityRuleNode;
  }

  if (node.type === "english_credential") {
    exactKeys(
      node,
      new Set(["type", "accepted", "mode", "minimumConfidence", "unknownPolicy"]),
      path
    );
    const accepted = parseValues(node.accepted, `${path}.accepted`);
    if (!accepted.every((value) => ENGLISH_CREDENTIALS.has(value as EnglishCredentialCode))) {
      throw new RuleConfigValidationError([
        `${path}.accepted supports only tem8 and cet6.`
      ]);
    }
    return {
      type: "english_credential",
      accepted: accepted as EnglishCredentialCode[],
      mode: mode(node.mode, `${path}.mode`),
      minimumConfidence: confidence(
        node.minimumConfidence,
        `${path}.minimumConfidence`,
        0
      ),
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    } satisfies EnglishCredentialRuleNode;
  }

  if (node.type === "range") {
    exactKeys(
      node,
      new Set(["type", "field", "minimum", "maximum", "unknownPolicy"]),
      path
    );
    if (
      node.field !== "yearsOfExperience" &&
      node.field !== "age" &&
      node.field !== "graduationYear"
    ) {
      throw new RuleConfigValidationError([
        `${path}.field must be yearsOfExperience, age, or graduationYear.`
      ]);
    }
    if (node.minimum === undefined && node.maximum === undefined) {
      throw new RuleConfigValidationError([
        `${path} requires minimum, maximum, or both.`
      ]);
    }
    const field = node.field;
    const boundaryLimits =
      field === "graduationYear"
        ? { minimum: 1900, maximum: 2100 }
        : field === "age"
          ? { minimum: 16, maximum: 100 }
          : { minimum: 0, maximum: 100 };
    const parseBoundary = (value: unknown, boundaryPath: string): number | undefined => {
      if (value === undefined) return undefined;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < boundaryLimits.minimum ||
        value > boundaryLimits.maximum
      ) {
        throw new RuleConfigValidationError([
          `${boundaryPath} must be a finite number between ${boundaryLimits.minimum} and ${boundaryLimits.maximum}.`
        ]);
      }
      return value;
    };
    const minimum = parseBoundary(node.minimum, `${path}.minimum`);
    const maximum = parseBoundary(node.maximum, `${path}.maximum`);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new RuleConfigValidationError([`${path}.minimum must not exceed maximum.`]);
    }
    return {
      type: "range",
      field,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    } satisfies RangeRuleNode;
  }

  if (node.type === "keyword") {
    exactKeys(node, new Set(["type", "field", "values", "mode", "unknownPolicy"]), path);
    return {
      type: "keyword",
      field: nonEmptyString(node.field, `${path}.field`, MAX_FIELD_LENGTH),
      values: parseValues(node.values, `${path}.values`),
      mode: mode(node.mode, `${path}.mode`),
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    } satisfies KeywordRuleNode;
  }

  if (node.type === "enum") {
    exactKeys(
      node,
      new Set(["type", "field", "values", "mode", "match", "unknownPolicy"]),
      path
    );
    return {
      type: "enum",
      field: nonEmptyString(node.field, `${path}.field`, MAX_FIELD_LENGTH),
      values: parseValues(node.values, `${path}.values`),
      mode: mode(node.mode, `${path}.mode`),
      match: textMatch(node.match, `${path}.match`),
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    } satisfies EnumRuleNode;
  }

  if (node.type === "text") {
    exactKeys(
      node,
      new Set(["type", "field", "value", "match", "unknownPolicy"]),
      path
    );
    return {
      type: "text",
      field: nonEmptyString(node.field, `${path}.field`, MAX_FIELD_LENGTH),
      value: nonEmptyString(node.value, `${path}.value`),
      match: textMatch(node.match, `${path}.match`),
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    } satisfies TextRuleNode;
  }

  if (node.type === "education_level") {
    exactKeys(node, new Set(["type", "minimum", "unknownPolicy"]), path);
    if (typeof node.minimum !== "string" || !EDUCATION_LEVELS.has(node.minimum as EducationLevel)) {
      throw new RuleConfigValidationError([
        `${path}.minimum must be high_school, associate, bachelor, master, or doctor.`
      ]);
    }
    return {
      type: "education_level",
      minimum: node.minimum as EducationLevel,
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    } satisfies EducationLevelRuleNode;
  }

  if (node.type === "graduate_status") {
    exactKeys(node, new Set(["type", "values", "mode", "unknownPolicy"]), path);
    const values = parseValues(node.values, `${path}.values`);
    if (!values.every((value) => GRADUATE_STATUSES.has(value as GraduateStatusCode))) {
      throw new RuleConfigValidationError([
        `${path}.values supports only current_or_upcoming_graduate and experienced.`
      ]);
    }
    if (node.mode !== "any") {
      throw new RuleConfigValidationError([
        `${path}.mode must be any because graduate statuses are mutually exclusive.`
      ]);
    }
    return {
      type: "graduate_status",
      values: values as GraduateStatusCode[],
      mode: "any",
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    } satisfies GraduateStatusRuleNode;
  }

  if (node.type === "semantic") {
    if (context.schemaVersion !== "1.1") {
      throw new RuleConfigValidationError([
        `${path} requires config.schemaVersion 1.1.`
      ]);
    }
    exactKeys(
      node,
      new Set([
        "type",
        "criterionId",
        "label",
        "executionMode",
        "factType",
        "expectedValues",
        "aliases",
        "valueMode",
        "rubric",
        "minimumConfidence",
        "unknownPolicy"
      ]),
      path
    );
    const criterionId = nonEmptyString(node.criterionId, `${path}.criterionId`, 100);
    if (!/^[a-z][a-z0-9._-]{2,99}$/u.test(criterionId)) {
      throw new RuleConfigValidationError([
        `${path}.criterionId must start with a lowercase letter and contain only lowercase letters, digits, dot, underscore, or hyphen.`
      ]);
    }
    if (context.semanticCriterionIds.has(criterionId)) {
      throw new RuleConfigValidationError([
        `${path}.criterionId duplicates another semantic criterion.`
      ]);
    }
    context.semanticCriterionIds.add(criterionId);
    const label = nonEmptyString(node.label, `${path}.label`, 120);
    const factType = nonEmptyString(node.factType, `${path}.factType`, 100);
    if (!/^[a-z][a-z0-9._-]{1,99}$/u.test(factType)) {
      throw new RuleConfigValidationError([
        `${path}.factType must be a stable lowercase identifier.`
      ]);
    }
    const base = {
      type: "semantic" as const,
      criterionId,
      label,
      factType,
      minimumConfidence: confidence(
        node.minimumConfidence,
        `${path}.minimumConfidence`
      ),
      unknownPolicy: parseUnknownPolicy(node.unknownPolicy, `${path}.unknownPolicy`)
    };
    if (node.executionMode === "normalized_entity") {
      if (node.rubric !== undefined) {
        throw new RuleConfigValidationError([
          `${path}.rubric is only valid for semantic_rubric.`
        ]);
      }
      const expectedValues = parseValues(node.expectedValues, `${path}.expectedValues`);
      const aliases = parseSemanticAliases(
        node.aliases,
        expectedValues,
        `${path}.aliases`
      );
      return {
        ...base,
        executionMode: "normalized_entity",
        expectedValues,
        ...(aliases ? { aliases } : {}),
        valueMode: mode(node.valueMode, `${path}.valueMode`)
      } satisfies SemanticRule;
    }
    if (node.executionMode === "semantic_rubric") {
      if (
        node.expectedValues !== undefined ||
        node.aliases !== undefined ||
        node.valueMode !== undefined
      ) {
        throw new RuleConfigValidationError([
          `${path}.expectedValues, aliases, and valueMode are only valid for normalized_entity.`
        ]);
      }
      return {
        ...base,
        executionMode: "semantic_rubric",
        rubric: nonEmptyString(node.rubric, `${path}.rubric`, 2_000)
      } satisfies SemanticRule;
    }
    throw new RuleConfigValidationError([
      `${path}.executionMode must be normalized_entity or semantic_rubric.`
    ]);
  }

  if (node.type === "institution_category") {
    exactKeys(
      node,
      new Set([
        "type",
        "educationStage",
        "categories",
        "mode",
        "required",
        "catalogVersion",
        "unknownPolicy"
      ]),
      path
    );
    const issues = validateInstitutionCategoryRule(node);
    if (issues.length > 0) {
      throw new RuleConfigValidationError(issues.map((issue) => `${path}: ${issue}`));
    }
    const parsed = structuredClone(node) as InstitutionCategoryRule;
    context.institutionLeaves.push(parsed);
    return parsed;
  }

  throw new RuleConfigValidationError([`${path} is an unsupported rule node.`]);
}

function parseComposite(value: JsonObject): CompositeRuleConfig {
  exactKeys(value, new Set(["schemaVersion", "name", "root", "institutionCatalog", "bossRecommendationFilters", "screeningFlow", "recruitment"]), "config");
  if (value.screeningFlow !== undefined && value.screeningFlow !== "boss_then_resume") {
    throw new RuleConfigValidationError(["config.screeningFlow is invalid."]);
  }
  const bossFilters = value.bossRecommendationFilters === undefined ? null : bossRecommendationFilterConfigSchema.safeParse(value.bossRecommendationFilters);
  if (bossFilters && !bossFilters.success) throw new RuleConfigValidationError([`BOSS 官方筛选配置无效：${bossFilters.error.message}`]);
  const recruitment = value.recruitment === undefined ? null : recruitmentConfigSchema.safeParse(value.recruitment);
  if (recruitment && !recruitment.success) throw new RuleConfigValidationError([`招聘目标配置无效：${recruitment.error.message}`]);
  const splitFlow = value.screeningFlow === "boss_then_resume";
  if (splitFlow && (!bossFilters?.success || bossFilters.data.mode !== "custom")) {
    throw new RuleConfigValidationError(["分工筛选需要明确配置第一步 BOSS 官方条件。"]);
  }
  if (value.schemaVersion !== "1.0" && value.schemaVersion !== "1.1") {
    throw new RuleConfigValidationError(["config.schemaVersion must be 1.0 or 1.1."]);
  }
  if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim())) {
    throw new RuleConfigValidationError(["config.name must be a non-empty string when provided."]);
  }
  const context: ParseContext = {
    nodeCount: 0,
    institutionLeaves: [],
    semanticCriterionIds: new Set(),
    schemaVersion: value.schemaVersion,
    splitFlow,
    allowEmptyRoot: (splitFlow && bossFilters?.success === true && hasBossFilters(bossFilters.data.fields)) || recruitment?.success === true && (recruitment.data.aiEnabled || recruitment.data.salaryCeilingYuan !== null)
  };
  const root = parseNode(value.root, "config.root", 0, context);
  if (!("children" in root)) {
    throw new RuleConfigValidationError(["config.root must be an AND/OR/NOT or all/any group node."]);
  }

  let institutionCatalog: InstitutionCatalog | undefined;
  if (context.institutionLeaves.length > 0) {
    if (value.institutionCatalog === undefined) {
      throw new RuleConfigValidationError([
        "config.institutionCatalog is required when institution rules are present."
      ]);
    }
    assertStrictCatalogShape(value.institutionCatalog);
    try {
      institutionCatalog = loadInstitutionCatalog(value.institutionCatalog);
    } catch (error) {
      throw new RuleConfigValidationError([
        `config.institutionCatalog is invalid or has been modified: ${
          error instanceof Error ? error.message : String(error)
        }`
      ]);
    }
    if (institutionCatalog.status !== "published") {
      throw new RuleConfigValidationError(["config.institutionCatalog must be published."]);
    }
    const mismatched = context.institutionLeaves.find(
      (leaf) => leaf.catalogVersion !== institutionCatalog!.version
    );
    if (mismatched) {
      throw new RuleConfigValidationError([
        `Institution rule catalogVersion ${mismatched.catalogVersion} does not match snapshot ${institutionCatalog.version}.`
      ]);
    }
  } else if (value.institutionCatalog !== undefined) {
    assertStrictCatalogShape(value.institutionCatalog);
    try {
      institutionCatalog = loadInstitutionCatalog(value.institutionCatalog);
    } catch (error) {
      throw new RuleConfigValidationError([
        `config.institutionCatalog is invalid or has been modified: ${
          error instanceof Error ? error.message : String(error)
        }`
      ]);
    }
  }

  return {
    schemaVersion: value.schemaVersion,
    ...(typeof value.name === "string" ? { name: value.name.trim() } : {}),
    root,
    ...(recruitment?.success ? { recruitment: recruitment.data } : {}),
    ...(splitFlow ? { screeningFlow: "boss_then_resume" as const } : {}),
    ...(bossFilters?.success ? { bossRecommendationFilters: bossFilters.data } : {}),
    ...(institutionCatalog ? { institutionCatalog } : {})
  };
}

export function isLegacyRuleConfig(value: RuleConfig): value is LegacyRuleConfig {
  return "requiredCapabilities" in value;
}

/** Strictly validates both API input and snapshots loaded back from the database. */
export function parseRuleConfig(value: unknown): RuleConfig {
  const config = record(value, "config");
  if ("requiredCapabilities" in config) return parseLegacy(config);
  return parseComposite(config);
}

/** Official filters belong to the bound job's recommendation pool. */
export function assertRuleScreeningSource(config: unknown, source: string, bossJobId: string | null): void {
  const value = config as { screeningFlow?: string } | null;
  if (value?.screeningFlow === "boss_then_resume" && (source !== "recommend" || !bossJobId)) {
    throw new Error("请先同步并选择对应的 BOSS 岗位，再从推荐牛人启动筛选。");
  }
}
