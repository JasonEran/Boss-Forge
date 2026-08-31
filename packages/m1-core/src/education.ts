import type { ParsedCandidate } from "@boss-forge/contracts";
import type {
  EducationAttendanceType,
  EducationExperienceInput,
  EducationStage
} from "@boss-forge/rule-engine";

type DraftExperience = Omit<EducationExperienceInput, "institutionRaw"> & {
  institutionRaw?: string;
};

type LabelKind =
  | { type: "institution"; stage?: EducationStage }
  | { type: "degree" }
  | { type: "major" }
  | { type: "campus" };

const QUALIFICATION_KEYS = new Set(["学历", "最高学历", "学历层次", "学位"]);
const MAJOR_KEYS = new Set(["专业", "所学专业", "主修专业"]);
const GENERIC_INSTITUTION_KEYS = new Set([
  "毕业院校",
  "毕业学校",
  "就读院校",
  "就读学校",
  "院校",
  "学校"
]);
const EDUCATION_CONTAINER_KEYS = new Set(["教育经历", "教育背景", "学历经历"]);

const EXPLICIT_LABEL_PATTERN =
  /(博士(?:研究生)?(?:毕业)?(?:院校|学校)|硕士(?:研究生)?(?:毕业)?(?:院校|学校)|研究生(?:毕业)?(?:院校|学校)|本科(?:毕业)?(?:院校|学校)|学士(?:毕业)?(?:院校|学校)|专科(?:毕业)?(?:院校|学校)|大专(?:毕业)?(?:院校|学校)|副学士(?:毕业)?(?:院校|学校)|毕业院校|毕业学校|就读院校|就读学校|院校|学校|最高学历|学历层次|学历|学位|博士专业|硕士专业|研究生专业|本科专业|专科专业|大专专业|所学专业|主修专业|专业|博士校区|硕士校区|本科校区|专科校区|大专校区|校区|学院)\s*[:：=]\s*/gu;

function normalizeKey(value: string): string {
  return value.normalize("NFKC").replace(/[\s:：=_\-/]/gu, "").trim();
}

function stageForPrefix(prefix: string): EducationStage | undefined {
  if (/^(?:博士|博士研究生)/u.test(prefix)) return "doctor";
  if (/^(?:硕士|硕士研究生|研究生)/u.test(prefix)) return "master";
  if (/^(?:本科|学士)/u.test(prefix)) return "bachelor";
  if (/^(?:专科|大专|副学士)/u.test(prefix)) return "associate";
  return undefined;
}

function institutionStageForKey(key: string): EducationStage | undefined | false {
  if (GENERIC_INSTITUTION_KEYS.has(key)) return undefined;
  if (!/(?:院校|学校)$/u.test(key)) return false;
  const stage = stageForPrefix(key);
  return stage ?? false;
}

function stageMajorForKey(key: string): EducationStage | undefined | false {
  if (MAJOR_KEYS.has(key)) return undefined;
  if (!/专业$/u.test(key)) return false;
  const stage = stageForPrefix(key);
  return stage ?? false;
}

function cleanValue(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^[\s,，;；|]+|[\s,，;；|]+$/gu, "")
    .trim();
}

function joinDistinct(values: string[]): string | undefined {
  const distinct = [...new Set(values.map(cleanValue).filter(Boolean))];
  return distinct.length > 0 ? distinct.join(" / ") : undefined;
}

function attendanceType(sourceText: string): EducationAttendanceType {
  if (/(?:交换生?|exchange)/iu.test(sourceText)) return "exchange";
  if (/(?:短期课程|短期项目|short\s+course)/iu.test(sourceText)) return "short_course";
  if (/(?:培训|training)/iu.test(sourceText)) return "training";
  if (/(?:联合培养|joint\s+(?:degree|program))/iu.test(sourceText)) return "joint_program";
  return "formal_degree";
}

function labelKind(labelValue: string): LabelKind | null {
  const label = normalizeKey(labelValue);
  const institutionStage = institutionStageForKey(label);
  if (institutionStage !== false) {
    return institutionStage === undefined
      ? { type: "institution" }
      : { type: "institution", stage: institutionStage };
  }
  if (QUALIFICATION_KEYS.has(label)) return { type: "degree" };
  const majorStage = stageMajorForKey(label);
  if (majorStage !== false) return { type: "major" };
  if (/(?:校区|学院)$/u.test(label)) return { type: "campus" };
  return null;
}

function parseLabeledBlock(blockValue: string, artifactRef: string): DraftExperience[] {
  const block = blockValue.normalize("NFKC").trim();
  if (!block) return [];
  EXPLICIT_LABEL_PATTERN.lastIndex = 0;
  const matches = [...block.matchAll(EXPLICIT_LABEL_PATTERN)];
  if (matches.length === 0) return [];

  const output: DraftExperience[] = [];
  let pendingDegree: string | undefined;
  let pendingMajor: string | undefined;
  let pendingCampus: string | undefined;
  let current: DraftExperience | null = null;

  const flush = (): void => {
    if (!current?.institutionRaw) return;
    output.push({
      ...current,
      attendanceType: attendanceType(block),
      evidence: { sourceText: block, artifactRef }
    });
    current = null;
  };

  matches.forEach((match, index) => {
    const rawLabel = match[1];
    if (!rawLabel || match.index === undefined) return;
    const valueStart = match.index + match[0].length;
    const nextStart = matches[index + 1]?.index ?? block.length;
    const value = cleanValue(block.slice(valueStart, nextStart));
    if (!value) return;
    const kind = labelKind(rawLabel);
    if (!kind) return;

    if (kind.type === "institution") {
      flush();
      current = {
        ...(kind.stage ? { stage: kind.stage } : {}),
        ...(pendingDegree ? { degree: pendingDegree } : {}),
        ...(pendingMajor ? { major: pendingMajor } : {}),
        ...(pendingCampus ? { campusOrCollege: pendingCampus } : {}),
        institutionRaw: value
      };
      pendingDegree = undefined;
      pendingMajor = undefined;
      pendingCampus = undefined;
      return;
    }
    if (kind.type === "degree") {
      const joined = joinDistinct([current?.degree ?? pendingDegree ?? "", value]);
      if (current && joined) current.degree = joined;
      else pendingDegree = joined;
      return;
    }
    if (kind.type === "major") {
      const joined = joinDistinct([current?.major ?? pendingMajor ?? "", value]);
      if (current && joined) current.major = joined;
      else pendingMajor = joined;
      return;
    }
    const joined = joinDistinct([current?.campusOrCollege ?? pendingCampus ?? "", value]);
    if (current && joined) current.campusOrCollege = joined;
    else pendingCampus = joined;
  });
  flush();
  return output;
}

function stageSpecificValue(
  fields: Record<string, string>,
  stage: EducationStage,
  kind: "major" | "campus"
): string | undefined {
  const values: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = normalizeKey(rawKey);
    if (kind === "major" && stageMajorForKey(key) === stage) values.push(rawValue);
    if (kind === "campus" && key.endsWith("校区") && stageForPrefix(key) === stage) {
      values.push(rawValue);
    }
  }
  return joinDistinct(values);
}

function fieldExperiences(fields: Record<string, string>): DraftExperience[] {
  const degrees = Object.entries(fields)
    .filter(([key]) => QUALIFICATION_KEYS.has(normalizeKey(key)))
    .map(([, value]) => value);
  const genericMajors = Object.entries(fields)
    .filter(([key]) => MAJOR_KEYS.has(normalizeKey(key)))
    .map(([, value]) => value);
  const genericCampuses = Object.entries(fields)
    .filter(([key]) => ["校区", "学院"].includes(normalizeKey(key)))
    .map(([, value]) => value);
  const degree = joinDistinct(degrees);
  const genericMajor = joinDistinct(genericMajors);
  const genericCampus = joinDistinct(genericCampuses);
  const output: DraftExperience[] = [];

  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const key = normalizeKey(rawKey);
    const stage = institutionStageForKey(key);
    if (stage === false) continue;
    const parsed = parseLabeledBlock(`${rawKey}：${rawValue}`, `candidate-field:${rawKey}`);
    if (parsed.length > 0) {
      for (const item of parsed) {
        const resolvedStage = item.stage ?? stage;
        const enriched: DraftExperience = { ...item };
        if (resolvedStage) {
          enriched.stage = resolvedStage;
          const major = stageSpecificValue(fields, resolvedStage, "major");
          const campus = stageSpecificValue(fields, resolvedStage, "campus");
          if (major) enriched.major = major;
          if (campus) enriched.campusOrCollege = campus;
        } else {
          if (degree) enriched.degree = degree;
          if (genericMajor) enriched.major = genericMajor;
          if (genericCampus) enriched.campusOrCollege = genericCampus;
        }
        output.push(enriched);
      }
    }
  }

  for (const [rawKey, rawValue] of Object.entries(fields)) {
    if (!EDUCATION_CONTAINER_KEYS.has(normalizeKey(rawKey))) continue;
    for (const block of rawValue.split(/\r?\n/u)) {
      output.push(...parseLabeledBlock(block, `candidate-field:${rawKey}`));
    }
  }
  return output;
}

function mergeExactDuplicates(values: DraftExperience[]): EducationExperienceInput[] {
  const output: EducationExperienceInput[] = [];
  for (const value of values) {
    const institutionRaw = cleanValue(value.institutionRaw ?? "");
    if (!institutionRaw) continue;
    const key = [
      value.stage ?? "",
      value.degree ?? "",
      institutionRaw,
      value.major ?? "",
      value.campusOrCollege ?? "",
      value.attendanceType ?? ""
    ]
      .map((item) => item.normalize("NFKC").trim())
      .join("\u0000");
    if (
      output.some(
        (item) =>
          [
            item.stage ?? "",
            item.degree ?? "",
            item.institutionRaw,
            item.major ?? "",
            item.campusOrCollege ?? "",
            item.attendanceType ?? ""
          ]
            .map((part) => part.normalize("NFKC").trim())
            .join("\u0000") === key
      )
    ) {
      continue;
    }
    output.push({ ...value, id: `education-${output.length + 1}`, institutionRaw });
  }
  return output;
}

/**
 * Extracts education only from explicit field labels. Free-form school mentions are deliberately
 * ignored so an OCR fragment cannot silently become a verified education experience.
 */
export function extractEducationExperiences(
  candidate: ParsedCandidate,
  resumeText?: string | null
): EducationExperienceInput[] {
  const values = fieldExperiences(candidate.fields);
  if (resumeText?.trim()) {
    for (const block of resumeText.split(/\r?\n/u)) {
      values.push(...parseLabeledBlock(block, "resume-ocr"));
    }
  }
  return mergeExactDuplicates(values);
}
