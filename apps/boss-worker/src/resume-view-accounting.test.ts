import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./m1.ts", import.meta.url), "utf8");

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("resume preview accounting", () => {
  it("allows at most one platform preview command per claimed attempt", () => {
    const attempt = between(
      "async function readSingleResumePreviewAttempt(",
      "async function processNextTask("
    );

    expect(attempt.match(/readResumePreview\(/gu)).toHaveLength(1);
    expect(attempt).not.toMatch(/\b(?:for|while)\s*\(/u);
    expect(source).not.toContain("RESUME_PREVIEW_MAX_ATTEMPTS");
  });

  it("records the possible view before handing control to the preview command", () => {
    const process = between(
      "async function processNextResumeScreening(",
      "async function main("
    );
    const recordIndex = process.indexOf("await repository.recordResumeView(");
    const previewIndex = process.indexOf("await readSingleResumePreviewAttempt(");

    expect(recordIndex).toBeGreaterThanOrEqual(0);
    // The accounting callback runs after target resolution, inside the attempt.
    expect(recordIndex).toBeGreaterThan(previewIndex);
    const attempt = between("async function readSingleResumePreviewAttempt(", "async function processNextTask(");
    expect(attempt.indexOf("await beforePreview()")).toBeGreaterThan(attempt.indexOf("refreshResumeCandidateTarget(job)"));
    expect(attempt.indexOf("await beforePreview()")).toBeLessThan(attempt.indexOf("readResumePreview(previewCommandForCandidate(target),"));
  });

  it("restores the task context before every preview, including a first attempt with a locator", () => {
    const attempt = between(
      "async function readSingleResumePreviewAttempt(",
      "async function processNextTask("
    );

    expect(attempt).not.toContain("job.resumeScreeningAttempts > 1");
    expect(attempt).not.toContain("if (refreshContext)");
    expect(attempt.indexOf("refreshResumeCandidateTarget(job)")).toBeLessThan(
      attempt.indexOf("readResumePreview(previewCommandForCandidate(target),")
    );
  });
});
