import { describe, expect, it } from "vitest";
import { bossJobCatalogSchema, bossJobAvailability } from "./boss-jobs.js";
describe("BOSS jobs catalog", () => {
  it("keeps same-name jobs with different IDs separate", () => {
    expect(bossJobCatalogSchema.parse({ complete: true, jobs: [
      { id: "a", name: "运营", status: "开放中" }, { id: "b", name: "运营", status: "已关闭" },
    ] }).jobs).toHaveLength(2);
  });
  it("rejects duplicate IDs or missing identity", () => {
    const job = { id: "a", name: "运营", status: "开放中" };
    expect(() => bossJobCatalogSchema.parse({ complete: true, jobs: [job, job] })).toThrow();
    expect(() => bossJobCatalogSchema.parse({ complete: true, jobs: [{ ...job, id: "" }] })).toThrow();
  });
  it("treats closed, draft and unknown provider status as unavailable", () => {
    expect(bossJobAvailability("开放中")).toBe("active");
    expect(bossJobAvailability("已关闭")).toBe("closed");
    expect(bossJobAvailability("待开放")).toBe("paused");
    expect(bossJobAvailability("审核中")).toBe("paused");
  });
});
