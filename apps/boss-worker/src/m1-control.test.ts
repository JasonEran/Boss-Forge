import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contactPriorityTransportModeFromEnvironment,
  m1ModeCapabilities,
  mayClaimAnotherResume,
  parseM1ExecutionOptions
} from "./m1.js";

const source = readFileSync(new URL("./m1.ts", import.meta.url), "utf8");

describe("M1 canary execution options", () => {
  it("keeps the historical normal, unlimited behavior by default", () => {
    expect(parseM1ExecutionOptions([], {})).toEqual({
      loop: false,
      mode: "normal",
      maxResumeAttempts: null
    });
    expect(
      parseM1ExecutionOptions([], {
        BOSS_FORGE_M1_MODE: "",
        BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "  "
      })
    ).toEqual({ loop: false, mode: "normal", maxResumeAttempts: null });
  });

  it("accepts strict environment controls inherited by the supervisor", () => {
    expect(
      parseM1ExecutionOptions(["--loop"], {
        BOSS_FORGE_M1_MODE: "resume-only",
        BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "3"
      })
    ).toEqual({ loop: true, mode: "resume-only", maxResumeAttempts: 3 });
  });

  it("accepts CLI modes and both limit syntaxes", () => {
    expect(
      parseM1ExecutionOptions(
        ["--loop", "--resume-only", "--max-resume-attempts", "3"],
        {}
      )
    ).toEqual({ loop: true, mode: "resume-only", maxResumeAttempts: 3 });
    expect(
      parseM1ExecutionOptions(["--resume-only", "--max-resume-attempts=20"], {})
    ).toEqual({ loop: false, mode: "resume-only", maxResumeAttempts: 20 });
  });

  it("gives explicit CLI values precedence over valid environment values", () => {
    expect(
      parseM1ExecutionOptions(
        ["--resume-only", "--max-resume-attempts", "3"],
        {
          BOSS_FORGE_M1_MODE: "normal",
          BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "9"
        }
      )
    ).toEqual({ loop: false, mode: "resume-only", maxResumeAttempts: 3 });
  });

  it.each([
    [{ BOSS_FORGE_M1_MODE: "resume" }, "BOSS_FORGE_M1_MODE"],
    [{ BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "0" }, "1 到 20"],
    [{ BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "21" }, "1 到 20"],
    [{ BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "3.0" }, "1 到 20"]
  ])("rejects invalid environment input %#", (environment, message) => {
    expect(() => parseM1ExecutionOptions([], environment)).toThrow(message);
  });

  it("rejects ambiguous or ineffective CLI controls", () => {
    expect(() =>
      parseM1ExecutionOptions(["--collection-only", "--resume-only"], {})
    ).toThrow("不能同时使用");
    expect(() =>
      parseM1ExecutionOptions(["--max-resume-attempts", "0"], {})
    ).toThrow("1 到 20");
    expect(() =>
      parseM1ExecutionOptions(["--max-resume-attempts"], {})
    ).toThrow("需要一个");
    expect(() => parseM1ExecutionOptions(["--unknown"], {})).toThrow("未知");
    expect(() =>
      parseM1ExecutionOptions(
        ["--collection-only", "--max-resume-attempts", "3"],
        {}
      )
    ).toThrow("不会查看简历");
  });
});

describe("M1 canary execution gates", () => {
  it("prioritizes only the contact worker mode that can actually run", () => {
    expect(contactPriorityTransportModeFromEnvironment({})).toBeNull();
    expect(contactPriorityTransportModeFromEnvironment({
      BOSS_FORGE_CONTACT_DISPATCH_MODE: "fake",
    })).toBe("fake");
    expect(contactPriorityTransportModeFromEnvironment({
      BOSS_FORGE_CONTACT_DISPATCH_MODE: "real",
      BOSS_FORGE_REAL_GREET_ENABLED: "0",
    })).toBeNull();
    expect(contactPriorityTransportModeFromEnvironment({
      BOSS_FORGE_CONTACT_DISPATCH_MODE: "real",
      BOSS_FORGE_REAL_GREET_ENABLED: "1",
    })).toBe("real");
  });

  it("makes resume-only skip schedules and collection, and collection-only skip resumes", () => {
    expect(m1ModeCapabilities("resume-only")).toEqual({
      materializeSchedules: false,
      processCollections: false,
      processResumes: true
    });
    expect(m1ModeCapabilities("collection-only")).toEqual({
      materializeSchedules: true,
      processCollections: true,
      processResumes: false
    });
    expect(m1ModeCapabilities("normal")).toEqual({
      materializeSchedules: true,
      processCollections: true,
      processResumes: true
    });
  });

  it("closes the claim gate after exactly three recorded attempts", () => {
    let recordedAttempts = 0;
    let claims = 0;
    while (mayClaimAnotherResume(recordedAttempts, 3)) {
      claims += 1;
      recordedAttempts += 1;
    }
    expect(claims).toBe(3);
    expect(recordedAttempts).toBe(3);
    expect(mayClaimAnotherResume(recordedAttempts, 3)).toBe(false);
    expect(mayClaimAnotherResume(100, null)).toBe(true);
  });

  it("records the attempt immediately after recordResumeView and gates before processing", () => {
    const recordIndex = source.indexOf("await repository.recordResumeView(");
    const loadedIndex = source.indexOf("resumeLoadedAt = Date.now();", recordIndex);
    const callbackIndex = source.indexOf("onResumeViewRecorded();", recordIndex);
    const previewIndex = source.indexOf("await readSingleResumePreviewAttempt(");
    expect(recordIndex).toBeGreaterThanOrEqual(0);
    expect(loadedIndex).toBeGreaterThan(callbackIndex);
    expect(callbackIndex).toBeGreaterThan(recordIndex);
    expect(callbackIndex).toBeGreaterThan(previewIndex);

    const loopIndex = source.indexOf("while (\n      !stopping");
    const loopProcessIndex = source.indexOf(
      "await processNextResumeScreening(",
      loopIndex
    );
    const loopGateIndex = source.lastIndexOf(
      "mayClaimAnotherResume(recordedResumeAttempts, options.maxResumeAttempts)",
      loopProcessIndex
    );
    expect(loopIndex).toBeGreaterThanOrEqual(0);
    expect(loopGateIndex).toBeGreaterThan(loopIndex);
    expect(loopGateIndex).toBeLessThan(loopProcessIndex);
  });

  it("skips a lost lease without preview, retry, failure, dwell, or canary accounting", () => {
    const processStart = source.indexOf("async function processNextResumeScreening(");
    const recordIndex = source.indexOf("await repository.recordResumeView(", processStart);
    const callbackIndex = source.indexOf("onResumeViewRecorded();", recordIndex);
    const previewIndex = source.indexOf("await readSingleResumePreviewAttempt(", processStart);
    const catchIndex = source.indexOf("} catch (error: unknown) {", previewIndex);
    const leaseIndex = source.indexOf(
      "if (error instanceof ResumeScreeningLeaseLostError)",
      catchIndex,
    );
    const errorCodeIndex = source.indexOf(
      "const errorCode = resumeScreeningErrorCode(message);",
      leaseIndex,
    );
    const leaseBlock = source.slice(leaseIndex, errorCodeIndex);

    expect(processStart).toBeGreaterThanOrEqual(0);
    expect(recordIndex).toBeGreaterThan(processStart);
    expect(callbackIndex).toBeGreaterThan(recordIndex);
    expect(previewIndex).toBeLessThan(callbackIndex);
    expect(leaseIndex).toBeGreaterThan(catchIndex);
    expect(errorCodeIndex).toBeGreaterThan(leaseIndex);
    expect(leaseBlock).toContain("m1.resume_screening.skipped_lease_lost");
    expect(leaseBlock).toContain("return true;");
    expect(leaseBlock).not.toContain("deferResumeScreening");
    expect(leaseBlock).not.toContain("failResumeScreening");
    expect(leaseBlock).not.toContain("onResumeViewRecorded");
    expect(leaseBlock).not.toContain("readSingleResumePreviewAttempt");
  });

  it("clears stale policy waits only after availability is ready and before claiming", () => {
    const availabilityReturn = source.indexOf("if (!availability.available)");
    const clearIndex = source.indexOf(
      "await repository.clearResumeScreeningWait(accountId)",
      availabilityReturn
    );
    const claimIndex = source.indexOf(
      "await repository.claimNextResumeScreening(",
      clearIndex
    );
    expect(availabilityReturn).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(availabilityReturn);
    expect(claimIndex).toBeGreaterThan(clearIndex);
  });

  it("passes the active contact mode into the database resume-claim gate", () => {
    const processStart = source.indexOf("async function processNextResumeScreening(");
    const claimStart = source.indexOf(
      "const job = await repository.claimNextResumeScreening(",
      processStart,
    );
    const claimEnd = source.indexOf(");", claimStart);
    const claim = source.slice(claimStart, claimEnd);

    expect(claimStart).toBeGreaterThan(processStart);
    expect(claim).toContain("contactPriorityTransportMode");
    expect(source).toContain(
      "contactPriorityTransportModeFromEnvironment(process.env)",
    );
  });

  it("releases the account lock before taking a resume batch break", () => {
    const processStart = source.indexOf("async function processNextResumeScreening(");
    const lockStart = source.indexOf("await withScreeningBrowser(accountId", processStart);
    const postLockMarker = source.indexOf(
      "if (postLockBatchBreakMs > 0)",
      lockStart
    );
    const lockBlock = source.slice(lockStart, postLockMarker);
    const postLockBlock = source.slice(postLockMarker, source.indexOf("return processed;", postLockMarker));

    expect(lockStart).toBeGreaterThan(processStart);
    expect(postLockMarker).toBeGreaterThan(lockStart);
    expect(lockBlock).toContain("RESUME_VIEW_POLICY.quotasEnabled");
    expect(lockBlock).toContain(
      "postLockBatchBreakMs = RESUME_VIEW_POLICY.breakMinutes * 60 * 1_000"
    );
    expect(lockBlock).not.toContain(
      "await waitWhileRunning(RESUME_VIEW_POLICY.breakMinutes * 60 * 1_000)"
    );
    expect(postLockBlock).toContain("await waitWhileRunning(postLockBatchBreakMs)");
  });
});
