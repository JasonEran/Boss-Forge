import { describe, expect, it } from "vitest";
import {
  autoRetryableResumeScreeningError,
  resumeRetryAt,
  resumeScreeningErrorCode,
} from "./resume-recovery.js";

describe("resume screening recovery", () => {
  it("classifies actionable BOSS and OCR failures", () => {
    expect(resumeScreeningErrorCode("BOSS_SOURCE_EXPIRED: card changed")).toBe(
      "source_expired"
    );
    expect(resumeScreeningErrorCode("BOSS_TARGET_MISSING")).toBe("target_missing");
    expect(resumeScreeningErrorCode("BOSS_TARGET_CHANGED: card changed")).toBe(
      "target_changed"
    );
    expect(resumeScreeningErrorCode("BOSS_TARGET_AMBIGUOUS: duplicate names")).toBe(
      "target_ambiguous"
    );
    expect(resumeScreeningErrorCode("BOSS_RESUME_CONTENT_EMPTY")).toBe("content_empty");
    expect(resumeScreeningErrorCode("TencentCloud OCR request failed")).toBe("ocr_failed");
    expect(resumeScreeningErrorCode("触发 BOSS 风控验证")).toBe("risk_control");
  });

  it("keeps capture failures distinct from empty content and does not reopen automatically", () => {
    const code = resumeScreeningErrorCode("BOSS_RESUME_CAPTURE_FAILED：简历截图失败：Tainted canvases may not be exported.");
    expect(code).toBe("worker_error");
    expect(autoRetryableResumeScreeningError(code)).toBe(false);
  });

  it("only auto-retries failures where a delayed page reload is safe and useful", () => {
    expect(autoRetryableResumeScreeningError("content_empty")).toBe(true);
    expect(autoRetryableResumeScreeningError("preview_not_opened")).toBe(true);
    expect(autoRetryableResumeScreeningError("source_expired")).toBe(false);
    expect(autoRetryableResumeScreeningError("target_missing")).toBe(false);
    expect(autoRetryableResumeScreeningError("target_changed")).toBe(false);
    expect(autoRetryableResumeScreeningError("target_ambiguous")).toBe(false);
    expect(autoRetryableResumeScreeningError("ocr_failed")).toBe(false);
    expect(autoRetryableResumeScreeningError("risk_control")).toBe(false);
  });

  it("uses a bounded retry schedule instead of immediately hammering the page", () => {
    const now = new Date("2026-09-04T01:00:00.000Z");
    expect(resumeRetryAt(now, 1).toISOString()).toBe("2026-09-04T01:05:00.000Z");
    expect(resumeRetryAt(now, 2).toISOString()).toBe("2026-09-04T01:10:00.000Z");
    expect(resumeRetryAt(now, 10).toISOString()).toBe("2026-09-04T01:30:00.000Z");
  });
});
