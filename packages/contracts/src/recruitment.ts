import { z } from "zod";

/** Saved in each rule version, and therefore frozen with its screening task. */
export const recruitmentConfigSchema = z.object({
  background: z.string().trim().max(6000),
  purpose: z.string().trim().max(2000),
  goals: z.string().trim().max(4000),
  salaryCeilingYuan: z.number().int().min(1).max(1_000_000).nullable(),
  salaryComparison: z.literal("upper"),
  aiEnabled: z.boolean(),
  recommendationThreshold: z.number().int().min(0).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.aiEnabled && (!value.background || !value.purpose || !value.goals)) {
    ctx.addIssue({ code: "custom", message: "启用 AI 评分前，请填写岗位背景、招聘目的和目标。" });
  }
});
export type RecruitmentConfig = z.infer<typeof recruitmentConfigSchema>;

export const RECRUITMENT_DIMENSIONS = [
  { key: "goals", label: "目标相关经历", maximum: 40 },
  { key: "skills", label: "岗位所需能力", maximum: 35 },
  { key: "delivery", label: "成果与执行证据", maximum: 25 },
] as const;

export type RecruitmentAssessment = {
  score: number;
  threshold: number;
  recommendation: "recommended" | "below_threshold";
  understanding: string;
  summary: string;
  dimensions: Array<{ key: string; label: string; score: number; maximum: number; reason: string; evidence: string[] }>;
  gaps: string[];
  interviewQuestions: string[];
  model: string;
  promptVersion: string;
  inputHash: string;
  completedAt: string;
};

export type CandidateAssessmentView = {
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  result: RecruitmentAssessment | null;
  error: string | null;
  ruleVersionId: string;
};

export type SalaryScreening = {
  status: "within_budget" | "above_budget" | "unknown";
  expected: string;
  upperYuan: number | null;
  ceilingYuan: number;
};

/** Only an explicit expected salary is comparable; never infer it from work history. */
export function screenExpectedSalary(fields: Record<string, string>, ceilingYuan: number): SalaryScreening {
  const expected = Object.entries(fields).find(([key]) => /^(期望薪资|期望薪酬|薪资期望|薪资|expectedSalary|salary)$/iu.test(key.trim()))?.[1]?.trim() ?? "";
  const normalized = expected.normalize("NFKC").replace(/\s+/gu, "").replace(/[–—~～至]/gu, "-").replace(/·\d+薪$/u, "");
  // BOSS K ranges are monthly salary. Annual, daily, hourly and open-ended
  // expectations remain unpriced rather than making an unsupported conversion.
  const match = normalized.match(/^(\d+(?:\.\d+)?)([kK千万元]?)(?:-(\d+(?:\.\d+)?)([kK千万元]?))?(?:\/月|元\/月|月薪)?$/u);
  let upperYuan: number | null = null;
  if (match) {
    const unit = match[4] || match[2] || "元";
    const scale = (value: string) => /[kK千]/u.test(value) ? 1000 : value === "万" ? 10000 : 1;
    const lower = Number(match[1]) * scale(match[2] || unit);
    const upper = Number(match[3] ?? match[1]) * scale(unit);
    if (lower > 0 && upper >= lower && upper <= 10_000_000) upperYuan = Math.round(upper);
  }
  return { status: upperYuan === null ? "unknown" : upperYuan > ceilingYuan ? "above_budget" : "within_budget", expected, upperYuan, ceilingYuan };
}
