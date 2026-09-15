import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveOcrEnabled,
  resumePreviewEnabled,
  workerBossEnvironment,
} from "./runtime.js";

describe.sequential("worker boss environment", () => {
  const originalProvider = process.env.BOSS_FORGE_OCR_PROVIDER;
  const originalOcr = process.env.BOSS_RESUME_OCR;

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.BOSS_FORGE_OCR_PROVIDER;
    else process.env.BOSS_FORGE_OCR_PROVIDER = originalProvider;
    if (originalOcr === undefined) delete process.env.BOSS_RESUME_OCR;
    else process.env.BOSS_RESUME_OCR = originalOcr;
  });

  it("disables boss-cli OCR when Tencent handles the screenshot", () => {
    process.env.BOSS_FORGE_OCR_PROVIDER = "tencent";
    process.env.BOSS_RESUME_OCR = "1";

    expect(workerBossEnvironment().BOSS_RESUME_OCR).toBe("0");
  });

  it("preserves boss-cli OCR when its built-in provider is selected", () => {
    process.env.BOSS_FORGE_OCR_PROVIDER = "boss";
    process.env.BOSS_RESUME_OCR = "1";

    expect(workerBossEnvironment().BOSS_RESUME_OCR).toBe("1");
  });

  it("fails closed when a real resume-view or OCR switch is misspelled", () => {
    expect(resumePreviewEnabled({ BOSS_FORGE_RESUME_PREVIEW_ENABLED: "1" })).toBe(true);
    expect(resumePreviewEnabled({ BOSS_FORGE_RESUME_PREVIEW_ENABLED: "true" })).toBe(true);
    expect(resumePreviewEnabled({ BOSS_FORGE_RESUME_PREVIEW_ENABLED: "flase" })).toBe(false);
    expect(resumePreviewEnabled({ BOSS_FORGE_RESUME_PREVIEW_ENABLED: "yesplease" })).toBe(false);
    expect(effectiveOcrEnabled({ BOSS_RESUME_OCR: "1" })).toBe(true);
    expect(effectiveOcrEnabled({ BOSS_RESUME_OCR: "enabled" })).toBe(false);
  });
});
