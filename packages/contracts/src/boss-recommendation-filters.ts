import { z } from "zod";

/** Choice labels resolve against BOSS; age uses [minimum, maximum | "不限"]. */
export const bossFilterFields = ["age", "activation", "gender", "keyword1", "recentNotView", "exchangeResumeWithColleague", "school", "firstDegree", "major", "switchJobFrequency", "experience", "intention", "degree", "salary"] as const;
export type BossFilterField = (typeof bossFilterFields)[number];
const labels = z.array(z.string().trim().min(1).max(60)).max(200).refine((items) => new Set(items).size === items.length, "筛选项不能重复");
const ageBound = z.string().regex(/^\d{1,3}$/, "年龄请输入整数");
export const bossFilterValuesSchema = z.object({
  degree: labels.optional(), experience: labels.optional(), school: labels.optional(),
  major: labels.max(5, "BOSS 专业最多选择 5 个").optional(), keyword1: labels.optional(),
  activation: labels.max(1).optional(), recentNotView: labels.max(1).optional(),
  gender: labels.max(1).optional(), exchangeResumeWithColleague: labels.max(1).optional(),
  switchJobFrequency: labels.max(1).optional(), intention: labels.optional(), salary: labels.max(1).optional(),
  firstDegree: labels.max(1).optional(),
  age: z.union([z.tuple([]), z.tuple([ageBound, z.union([ageBound, z.literal("不限")])])])
    .refine(value => !value.length || value[1] === "不限" || Number(value[0]) <= Number(value[1]), "年龄下限不能大于上限").optional(),
}).strict();
export const bossFilterDefinitionSchema = z.object({
  key: z.enum(bossFilterFields), label: z.string().trim().min(1).max(100),
  kind: z.enum(["single", "multiple", "range"]), source: z.enum(["vip", "normal"]),
  available: z.boolean(), tip: z.string().max(1000).optional(),
  maxSelected: z.number().int().min(1).max(200).optional(),
  range: z.object({ min: z.number().int(), max: z.number().int(), step: z.number().int().positive() }).optional(),
});
export type BossFilterDefinition = z.infer<typeof bossFilterDefinitionSchema>;
/** Native shortlist names and catalog names verified on BOSS on 2026-09-08.
 * Keep old saved rules resolvable after another rule replaces the job's shortcuts. */
export const bossMajorLabelAliases: Record<string, string> = {
  '新闻传播学类': '新闻传播类', '管理科学与工程类': '管理工程类', '经济与贸易类': '经济贸易类',
};
export const bossDynamicFilterFields = ['major', 'keyword1'] as const;
export const bossFilterOptionsSnapshotSchema = z.object({
  bossJobId: z.string().trim().min(1).max(256),
  bossJobName: z.string().trim().min(1).max(512),
  fetchedAt: z.string().datetime(),
  majorGroups: z.array(z.object({ label: z.string().trim().min(1).max(60), options: z.array(z.string().trim().min(1).max(60)).max(200) })).max(60).optional(),
  majorAliases: z.record(z.string(), z.string()).optional(),
  definitions: z.array(bossFilterDefinitionSchema).max(50).refine(items => new Set(items.map(item => item.key)).size === items.length, "筛选字段不能重复").optional(),
  conflicts: z.array(z.object({
    field: z.enum(bossFilterFields), option: z.string().max(60),
    targets: z.array(z.object({ field: z.enum(bossFilterFields), options: z.array(z.string().max(60)).max(200) })).max(30),
  })).max(500).optional(),
  fields: z.partialRecord(z.enum(bossFilterFields), z.array(z.string().trim().min(1).max(60)).max(200)),
});
export type BossFilterOptionsSnapshot = z.infer<typeof bossFilterOptionsSnapshotSchema>;
export const bossRecommendationFilterConfigSchema = z.object({
  mode: z.enum(["auto", "custom", "off"]), fields: bossFilterValuesSchema.default({}),
  optionsSnapshot: bossFilterOptionsSnapshotSchema.optional(),
}).strict();
export type BossRecommendationFilterConfig = z.infer<typeof bossRecommendationFilterConfigSchema>;
export const bossRecommendationFilterPlanSchema = z.object({
  version: z.literal(1), mode: z.enum(["auto", "custom", "off"]), fields: bossFilterValuesSchema,
}).strict();
export type BossRecommendationFilterPlan = z.infer<typeof bossRecommendationFilterPlanSchema>;

export function unavailableBossSelections(fields: BossRecommendationFilterPlan['fields'], snapshot: BossFilterOptionsSnapshot): string[] {
  // Older stored snapshots only describe major/keywords. New snapshots cover the entire panel.
  const keys = snapshot.definitions ? bossFilterFields : bossDynamicFilterFields;
  const unavailable = keys.flatMap(key => {
    const selected = fields[key] ?? [];
    if (!selected.length) return [];
    const definition = snapshot.definitions?.find(item => item.key === key);
    const label = definition?.label ?? bossFilterLabels[key];
    if (snapshot.definitions && (!definition || !definition.available)) return [`${label}：当前岗位不可用`];
    if (key === 'age') {
      const range = definition?.range;
      return !range || Number(selected[0]) < range.min || Number(selected[0]) > range.max ||
        (selected[1] !== '不限' && (Number(selected[1]) > range.max || Number(selected[1]) < Number(selected[0]))) ? [`${label}：超出 BOSS 可选范围`] : [];
    }
    if (definition?.maxSelected && selected.length > definition.maxSelected) return [`${label}：最多选择 ${definition.maxSelected} 项`];
    return selected.filter(item => !(snapshot.fields[key] ?? []).includes(item)).map(item => `${label}：${item}`);
  });
  const conflicts = (snapshot.conflicts ?? []).flatMap(rule => (fields[rule.field] ?? []).includes(rule.option) ? rule.targets.flatMap(target =>
    (fields[target.field] ?? []).filter(item => target.options.includes(item)).map(item => `${bossFilterLabels[rule.field]}「${rule.option}」与${bossFilterLabels[target.field]}「${item}」不能同时选择`)) : []);
  return [...new Set([...unavailable, ...conflicts])];
}

export function hasBossFilters(fields: BossRecommendationFilterPlan["fields"]): boolean {
  return bossFilterFields.some((key) => Boolean(fields[key]?.length));
}

export function sameBossFilterFields(left: BossRecommendationFilterPlan["fields"], right: BossRecommendationFilterPlan["fields"]): boolean {
  return bossFilterFields.every((key) => JSON.stringify(key === "age" ? left[key] ?? [] : [...(left[key] ?? [])].sort()) === JSON.stringify(key === "age" ? right[key] ?? [] : [...(right[key] ?? [])].sort()));
}

/** These profile fields belong to BOSS in the new split authoring flow. */
export function isBossManagedResumeNode(node: Record<string, unknown>): boolean {
  return node.type === "education_level" ||
    (node.type === "range" && node.field === "yearsOfExperience") ||
    (node.type === "enum" && ["bossplatformtags", "major", "education", "degree"].includes(String(node.field).toLowerCase()));
}

export const bossFilterLabels: Record<BossFilterField, string> = {
  age: "年龄", gender: "性别", exchangeResumeWithColleague: "是否与同事交换简历",
  switchJobFrequency: "跳槽频率", intention: "求职状态", salary: "薪资待遇", firstDegree: "第一学历",
  degree: "学历", experience: "经验", school: "院校", major: "专业",
  keyword1: "牛人关键词", activation: "活跃度", recentNotView: "近期未看过",
};
export function describeBossFilters(plan: BossRecommendationFilterPlan): string {
  return bossFilterFields.flatMap((key) => plan.fields[key]?.length
    ? [`${bossFilterLabels[key]}：${plan.fields[key]!.join(key === "age" ? "～" : "、")}`] : []).join("；") || "不限（使用该岗位推荐）";
}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Only mandatory AND branches can narrow the whole candidate pool. OR/NOT stay local. */
export function planBossRecommendationFilters(config: unknown): BossRecommendationFilterPlan {
  const rootConfig = object(config);
  const setting = rootConfig?.bossRecommendationFilters === undefined ? { mode: "auto" as const, fields: {} }
    : bossRecommendationFilterConfigSchema.parse(rootConfig.bossRecommendationFilters);
  if (setting.mode !== "auto") return { version: 1, mode: setting.mode, fields: setting.mode === "off" ? {} : setting.fields };
  const leaves: Record<string, unknown>[] = [];
  function visit(value: unknown) {
    const node = object(value);
    if (!node) return;
    if (Array.isArray(node.children)) {
      if (node.operator === "AND" || node.type === "all") node.children.forEach(visit);
    } else if (node.unknownPolicy !== "ignore") leaves.push(node);
  }
  visit(rootConfig?.root);
  const fields: BossRecommendationFilterPlan["fields"] = {};
  const degrees = ["high_school", "associate", "bachelor", "master", "doctor"];
  const degreeLabels = ["高中", "大专", "本科", "硕士", "博士"];
  const degreeIndex = Math.max(-1, ...leaves.filter((leaf) => leaf.type === "education_level").map((leaf) => degrees.indexOf(String(leaf.minimum))));
  if (degreeIndex >= 0) fields.degree = [...(degreeIndex === 0 ? ["中专/中技"] : []), ...degreeLabels.slice(degreeIndex)];
  const ranges = leaves.filter((leaf) => leaf.type === "range" && leaf.field === "yearsOfExperience");
  if (ranges.length) {
    const min = Math.max(0, ...ranges.map((leaf) => typeof leaf.minimum === "number" ? leaf.minimum : 0));
    const max = Math.min(Infinity, ...ranges.map((leaf) => typeof leaf.maximum === "number" ? leaf.maximum : Infinity));
    const buckets: Array<[string, number, number]> = [["在校/应届", 0, 0], ["1年以内", 0, 1], ["1-3年", 1, 3], ["3-5年", 3, 5], ["5-10年", 5, 10], ["10年以上", 10, Infinity]];
    // Include overlapping boundary bands; exact years remain checked from the resume.
    if (min <= max && min > 0) fields.experience = buckets.filter(([, low, high]) => low <= max && high >= min).map(([label]) => label);
  }
  return { version: 1, mode: "auto", fields };
}
