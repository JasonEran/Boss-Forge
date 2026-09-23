import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./m1.ts", import.meta.url), "utf8");

describe("worker screening budget stop", () => {
  it("seals an over-budget account before the next resume claim or collection chunk", () => {
    const loop = source.slice(source.indexOf("while (\n      !stopping"));
    const seal = loop.indexOf("await sealScreeningBudgets(repository)");
    const resume = loop.indexOf("await processNextResumeScreening(");
    const collect = loop.indexOf("await processNextTask(");
    expect(seal).toBeGreaterThanOrEqual(0);
    expect(seal).toBeLessThan(resume);
    expect(resume).toBeLessThan(collect);

    const process = source.slice(
      source.indexOf("async function processNextTask("),
      source.indexOf("async function processNextResumeScreening("),
    );
    const claimed = process.indexOf("await repository.claimNextTask(");
    const met = process.indexOf("await repository.sealScreeningBudgetIfMet(task.id)");
    const read = process.indexOf("readBoundBossRecommendation");
    expect(claimed).toBeGreaterThanOrEqual(0);
    expect(met).toBeGreaterThan(claimed);
    expect(read).toBeGreaterThan(met);
    expect(process).not.toContain("sentGreets >= totalLimit");
  });
});
