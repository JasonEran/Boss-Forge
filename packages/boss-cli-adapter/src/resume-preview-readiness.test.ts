import { waitForVisibleCResumeIframeReady } from "@joohw/boss-cli/dist/common/c_resume_capture.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function previewPage(contentReady: boolean) {
  const contentFrame = {
    evaluate: async () =>
      contentReady ? { ready: true, signature: "120:80:0" } : { ready: false, signature: "" }
  };
  const iframe = {
    boundingBox: async () => ({ x: 0, y: 0, width: 800, height: 1200 }),
    contentFrame: async () => contentFrame,
    dispose: async () => undefined
  };
  const frame = {
    evaluate: async () => true,
    $: async () => iframe
  };
  return {
    frames: () => [frame]
  };
}

describe("resume preview readiness", () => {
  it("does not accept a visible but blank resume iframe", async () => {
    await expect(
      waitForVisibleCResumeIframeReady(previewPage(false) as never, 120)
    ).resolves.toBe(false);
  });

  it("accepts a resume iframe after meaningful content renders", async () => {
    await expect(
      waitForVisibleCResumeIframeReady(previewPage(true) as never, 1_200)
    ).resolves.toBe(true);
  });

  it("accepts text or rendered resume content and rechecks before capture", () => {
    const patch = readFileSync(
      new URL("../../../patches/@joohw__boss-cli@0.6.6.patch", import.meta.url),
      "utf8",
    );
    expect(patch).toContain("textLength >= 80 || renderedVisuals");
    expect(patch).toContain('querySelectorAll("img, canvas, embed, object")');
    expect(patch).toContain("stableReadyChecks >= 2");
    expect(patch).toContain(
      "const ready = await waitForVisibleCResumeIframeReady(page, 30_000);",
    );
    expect(patch).toContain("if (!ready)");
    expect(patch).toContain("await captureFullResume(page, iframe, absPath)");
    expect(patch).toContain("stableBottom < 3");
    expect(patch).toContain("BOSS_RESUME_INCOMPLETE");
    // Segment continuity and native canvas coverage are exercised in the
    // Chromium full-resume-capture integration fixture, including blank footers.
    expect(patch).toContain("await closeCResumePanel(page)");
    expect(patch).not.toContain("await page.reload(");
  });

  it("does not repeatedly switch the active job and reacquires a replaced iframe", () => {
    const patch = readFileSync(
      new URL("../../../patches/@joohw__boss-cli@0.6.6.patch", import.meta.url),
      "utf8",
    );
    expect(patch).toContain("normalizeLabel(currentLabel).includes(normalizeLabel(kw))");
    expect(patch).toContain("async function withRecommendFrameRetry(page, operation)");
    expect(patch).toContain("const attempts = 4;");
    expect(patch).toContain(
      "frame got detached|detached frame|execution context was destroyed|cannot find context with specified id",
    );
    expect(patch).toContain(
      "withRecommendFrameRetry(page, (currentFrame) => readRecommendList(currentFrame))",
    );
  });
});
