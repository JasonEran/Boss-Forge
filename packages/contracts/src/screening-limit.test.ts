import { describe, expect, it } from "vitest";
import {
  countsAsScreeningPass,
  screeningBudgetMet,
  screeningBudgetWait,
  screeningChunkLimit,
  screeningChunkSizes,
  screeningCandidateLimit,
  screeningPassCount,
  SCREENING_CHUNK_SIZE
} from "./screening-limit.js";

describe("screening chunks", () => {
  it("keeps requests of 20 or fewer as a single chunk", () => {
    expect(screeningChunkSizes(1)).toEqual([1]);
    expect(screeningChunkSizes(20)).toEqual([20]);
    expect(screeningChunkLimit(20, 0)).toBe(20);
  });

  it("splits larger requests into waves of at most 20", () => {
    expect(SCREENING_CHUNK_SIZE).toBe(20);
    expect(screeningChunkSizes(40)).toEqual([20, 20]);
    expect(screeningChunkSizes(30)).toEqual([20, 10]);
    expect(screeningChunkSizes(45)).toEqual([20, 20, 5]);
  });

  it("recomputes the next wave from remaining work", () => {
    expect(screeningChunkLimit(40, 0)).toBe(20);
    expect(screeningChunkLimit(40, 20)).toBe(20);
    expect(screeningChunkLimit(30, 20)).toBe(10);
    expect(screeningChunkLimit(20, 20)).toBe(0);
    expect(screeningCandidateLimit(40)).toBe(40);
    expect(screeningCandidateLimit(500)).toBe(500);
    expect(screeningChunkSizes(100)).toEqual([20, 20, 20, 20, 20]);
  });
});

describe("screening budget", () => {
  const rows = [
    { ruleDecision: "matched", resumeScreeningStatus: "screened" },
    { ruleDecision: "matched", resumeScreeningStatus: "screened" },
    { ruleDecision: "not_matched", resumeScreeningStatus: "screened" },
    { ruleDecision: "matched", resumeScreeningStatus: "failed" },
    { ruleDecision: "insufficient", resumeScreeningStatus: "failed" },
    { ruleDecision: "matched", resumeScreeningStatus: "no_text" },
    { ruleDecision: "matched", resumeScreeningStatus: "queued" },
    { ruleDecision: "ambiguous", resumeScreeningStatus: "screened" },
  ];

  it("counts only matched resumes that finished screening", () => {
    expect(countsAsScreeningPass(rows[0]!)).toBe(true);
    expect(countsAsScreeningPass(rows[2]!)).toBe(false);
    expect(countsAsScreeningPass(rows[3]!)).toBe(false);
    expect(countsAsScreeningPass(rows[5]!)).toBe(false);
    expect(screeningPassCount(rows)).toBe(2);
  });

  it("stops auto-greet off at N screening passes, ignoring greets and non-passes", () => {
    const screeningPasses = screeningPassCount(rows);
    expect(screeningBudgetMet({
      autoGreet: false,
      candidateLimit: 2,
      successfulGreets: 0,
      screeningPasses,
    })).toBe(true);
    expect(screeningBudgetMet({
      autoGreet: false,
      candidateLimit: 3,
      successfulGreets: 100,
      screeningPasses,
    })).toBe(false);
    expect(screeningBudgetWait(false)).toEqual({
      code: "screening_pass_target_met",
      message: "已达到设定的筛通过人数，已停止继续筛选。",
    });
  });

  it("stops auto-greet on at N successful greets, even when passes already exceed the limit", () => {
    expect(screeningBudgetMet({
      autoGreet: true,
      candidateLimit: 100,
      successfulGreets: 100,
      screeningPasses: 0,
    })).toBe(true);
    expect(screeningBudgetMet({
      autoGreet: true,
      candidateLimit: 100,
      successfulGreets: 99,
      screeningPasses: 500,
    })).toBe(false);
    expect(screeningBudgetWait(true).code).toBe("greet_target_met");
  });
});
