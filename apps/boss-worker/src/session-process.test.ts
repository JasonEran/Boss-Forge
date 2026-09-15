import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  isExpectedM1CanaryExit,
  parseM1CanaryCompletionLine,
  sessionChildExitMessage,
  waitForSessionChildExit
} from "./session-process.js";

describe("session child termination", () => {
  it("resolves a non-zero exit instead of bypassing supervisor cleanup", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"]);
    await expect(waitForSessionChildExit(child)).resolves.toEqual({
      code: 7,
      signal: null,
      error: null
    });
  });

  it("resolves a signal exit so OOM and forced stops become terminal status", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const exit = waitForSessionChildExit(child);
    child.kill("SIGTERM");
    const result = await exit;

    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(sessionChildExitMessage(result)).toContain("信号 SIGTERM");
  });

  it("resolves spawn errors and settles cleanup exactly once", async () => {
    let settled = 0;
    const child = spawn("boss-forge-command-that-does-not-exist", []);
    const result = await waitForSessionChildExit(child, () => {
      settled += 1;
    });

    expect(result.code).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.error).toBeTruthy();
    expect(sessionChildExitMessage(result)).toContain("启动失败");
    expect(settled).toBe(1);
  });
});

describe("M1 supervisor canary completion", () => {
  const completedThree = parseM1CanaryCompletionLine(
    JSON.stringify({
      ok: true,
      event: "m1.canary.completed",
      mode: "resume-only",
      recordedResumeAttempts: 3,
      maxResumeAttempts: 3
    })
  );

  it("accepts only a matching controlled zero exit", () => {
    expect(completedThree).not.toBeNull();
    expect(
      isExpectedM1CanaryExit(
        { code: 0, signal: null, error: null },
        completedThree,
        {
          BOSS_FORGE_M1_MODE: "resume-only",
          BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "3"
        }
      )
    ).toBe(true);
    const normalCompleted = parseM1CanaryCompletionLine(
      JSON.stringify({
        ok: true,
        event: "m1.canary.completed",
        mode: "normal",
        recordedResumeAttempts: 3,
        maxResumeAttempts: 3
      })
    );
    expect(
      isExpectedM1CanaryExit(
        { code: 0, signal: null, error: null },
        normalCompleted,
        {
          BOSS_FORGE_M1_MODE: "",
          BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "3"
        }
      )
    ).toBe(true);
  });

  it("does not swallow normal exits, failures, or mismatched completion claims", () => {
    expect(
      isExpectedM1CanaryExit(
        { code: 0, signal: null, error: null },
        completedThree,
        {}
      )
    ).toBe(false);
    expect(
      isExpectedM1CanaryExit(
        { code: 1, signal: null, error: null },
        completedThree,
        {
          BOSS_FORGE_M1_MODE: "resume-only",
          BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "3"
        }
      )
    ).toBe(false);
    expect(
      isExpectedM1CanaryExit(
        { code: 0, signal: null, error: null },
        completedThree,
        {
          BOSS_FORGE_M1_MODE: "resume-only",
          BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "2"
        }
      )
    ).toBe(false);
    expect(
      isExpectedM1CanaryExit(
        { code: 0, signal: null, error: null },
        null,
        {
          BOSS_FORGE_M1_MODE: "resume-only",
          BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: "3"
        }
      )
    ).toBe(false);
  });

  it("requires an exact JSON completion event", () => {
    expect(parseM1CanaryCompletionLine("m1.canary.completed")).toBeNull();
    expect(
      parseM1CanaryCompletionLine(
        JSON.stringify({
          ok: false,
          event: "m1.canary.completed",
          mode: "resume-only",
          recordedResumeAttempts: 3,
          maxResumeAttempts: 3
        })
      )
    ).toBeNull();
  });

  it("supports a future finite collection-only completion without weakening normal mode", () => {
    const collectionCompleted = parseM1CanaryCompletionLine(
      JSON.stringify({
        ok: true,
        event: "m1.canary.completed",
        mode: "collection-only",
        recordedResumeAttempts: 0,
        maxResumeAttempts: null
      })
    );
    expect(
      isExpectedM1CanaryExit(
        { code: 0, signal: null, error: null },
        collectionCompleted,
        { BOSS_FORGE_M1_MODE: "collection-only" }
      )
    ).toBe(true);
    expect(
      isExpectedM1CanaryExit(
        { code: 0, signal: null, error: null },
        collectionCompleted,
        {
          BOSS_FORGE_M1_MODE: "collection-only",
          BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: ""
        }
      )
    ).toBe(true);
    const impossibleCollectionView = parseM1CanaryCompletionLine(
      JSON.stringify({
        ok: true,
        event: "m1.canary.completed",
        mode: "collection-only",
        recordedResumeAttempts: 1,
        maxResumeAttempts: null
      })
    );
    expect(
      isExpectedM1CanaryExit(
        { code: 0, signal: null, error: null },
        impossibleCollectionView,
        { BOSS_FORGE_M1_MODE: "collection-only" }
      )
    ).toBe(false);
  });
});
