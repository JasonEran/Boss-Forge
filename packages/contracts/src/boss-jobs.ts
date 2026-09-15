import { z } from "zod";

export const bossJobSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  status: z.string().trim().min(1).max(100),
});
export const bossJobCatalogSchema = z.object({
  jobs: z.array(bossJobSchema).max(500),
  complete: z.boolean(),
}).refine((catalog) => new Set(catalog.jobs.map((job) => job.id)).size === catalog.jobs.length,
  "BOSS 岗位列表包含重复 ID，请重新同步。");
export type BossJob = z.infer<typeof bossJobSchema>;
export type BossJobCatalog = z.infer<typeof bossJobCatalogSchema>;
export function bossJobAvailability(status: string): "active" | "paused" | "closed" {
  if (/已关闭|已下线|停止招聘|已删除/u.test(status)) return "closed";
  if (/开放中|招聘中|发布中/u.test(status)) return "active";
  return "paused";
}
