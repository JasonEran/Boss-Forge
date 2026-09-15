import { describe, expect, it } from "vitest";
import { BossCliExecutionError } from "@boss-forge/boss-cli-adapter";
import { safeWorkerErrorMessage } from "./error-message.js";

function executionError(stderr: string): BossCliExecutionError {
  return new BossCliExecutionError("boss-cli exited with code 1.", {
    command: { type: "preview", candidateTarget: "候选人" },
    argv: ["preview", "候选人"],
    version: "test",
    entrypoint: "/test/boss-cli.js",
    startedAt: "2026-09-02T00:00:00.000Z",
    finishedAt: "2026-09-02T00:00:01.000Z",
    durationMs: 1_000,
    exitCode: 1,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: "",
    stderr
  });
}

describe("safeWorkerErrorMessage", () => {
  it("keeps the CLI diagnostic so screening failures are actionable", () => {
    expect(safeWorkerErrorMessage(executionError("未找到候选人卡片"))).toBe(
      "boss-cli exited with code 1. 未找到候选人卡片"
    );
  });

  it("redacts configured credentials from diagnostics", () => {
    expect(
      safeWorkerErrorMessage(executionError("request failed: secret-value"), {
        BOSS_FORGE_SEMANTIC_API_KEY: "secret-value"
      })
    ).toBe("boss-cli exited with code 1. request failed: [REDACTED]");
  });
});
