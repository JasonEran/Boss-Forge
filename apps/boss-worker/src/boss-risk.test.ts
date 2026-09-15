import { describe, expect, it } from "vitest";
import { BossCliExecutionError } from "@boss-forge/boss-cli-adapter";
import { isBossRiskSignal } from "./boss-risk.js";

describe("BOSS risk signal classification", () => {
  it.each([
    "https://www.zhipin.com/web/common/security/blocktip.html",
    "BOSS 要求完成安全验证",
    "captcha challenge was shown",
    "账号访问异常，请稍后重试"
  ])("recognizes %s", (message) => {
    expect(isBossRiskSignal(new Error(message))).toBe(true);
  });

  it("inspects boss-cli stderr instead of relying on the generic wrapper message", () => {
    const error = new BossCliExecutionError("boss-cli exited with code 1.", {
      command: { type: "positions" },
      argv: ["positions"],
      version: "test",
      entrypoint: "test",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      durationMs: 1,
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: "",
      stderr: "redirected to /web/user/safe/verify"
    });
    expect(isBossRiskSignal(error)).toBe(true);
  });

  it("does not label ordinary worker failures as platform risk control", () => {
    expect(isBossRiskSignal(new Error("Database connection failed."))).toBe(false);
  });
});
