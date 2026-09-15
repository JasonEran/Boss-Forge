import { describe, expect, it } from "vitest";
import { recruitmentConfigSchema, screenExpectedSalary } from "./recruitment.js";

import { briefFixture } from "./recruitment.test-fixture.js";
describe("recruitment salary upper bound", () => {
  it.each([["10-15K", 15000, "above_budget"], ["8–12k·13薪", 12000, "within_budget"], ["1-1.5万", 15000, "above_budget"], ["10000-12000元/月", 12000, "within_budget"], ["12K", 12000, "within_budget"], ["8K-15K", 15000, "above_budget"]])("compares %s using the highest monthly expectation", (salary, upper, status) => {
    expect(screenExpectedSalary({ 期望薪资: String(salary) }, 12000)).toMatchObject({ upperYuan: upper, status });
  });
  it.each(["面议", "15K以上", "20-30万/年", "300元/天", "150元/时", "15-10K", "待定", "0-12K", ""])('does not invent a monthly expectation for %s', salary => {
    expect(screenExpectedSalary({ 薪资: salary }, 12000).status).toBe("unknown");
  });
  it("ignores salaries in historical job descriptions", () => {
    expect(screenExpectedSalary({ 工作经历: "过去月薪30K", 期望薪资: "10-12K" }, 12000).status).toBe("within_budget");
  });
  it("validates the brief and rejects configurable lower-bound comparison", () => {
    expect(recruitmentConfigSchema.parse(briefFixture).recommendationThreshold).toBe(70);
    expect(recruitmentConfigSchema.safeParse({ ...briefFixture, salaryComparison: "lower" }).success).toBe(false);
    expect(recruitmentConfigSchema.safeParse({ ...briefFixture, goals: "" }).success).toBe(false);
    expect(recruitmentConfigSchema.safeParse({ ...briefFixture, recommendationThreshold: 101 }).success).toBe(false);
    expect(recruitmentConfigSchema.safeParse({ ...briefFixture, recommendationThreshold: 0 }).success).toBe(true);
  });
});
