import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeScreeningJob } from "@boss-forge/data";
import { parseBossOutput, readResumeArtifact, runBossCommand } from "@boss-forge/boss-cli-adapter";
import { readSingleResumePreviewAttempt } from "./m1.js";
import { recoverResumeCandidateInRecommendation } from "./resume-list-recovery.js";

vi.mock("./resume-list-recovery.js", () => ({ recoverResumeCandidateInRecommendation: vi.fn() }));

vi.mock("@boss-forge/boss-cli-adapter", async (original) => ({
  ...await original<typeof import("@boss-forge/boss-cli-adapter")>(),
  readResumeArtifact: vi.fn(),
  runBossCommand: vi.fn()
}));
const run = vi.mocked(runBossCommand);
const recover = vi.mocked(recoverResumeCandidateInRecommendation);
const list = (id: string, info = "上海 / 5年 / 本科") => `当前岗位：英语老师\n常规推荐（1）\n  - 1. 测试候选人｜BOSS候选人ID:${id}｜信息:${info}｜经验:示例工作经历`;
function job(attempts = 1): ResumeScreeningJob {
  const parsed = parseBossOutput("0.6.6", { type: "recommend" }, list("original-card-id"));
  if (parsed.kind !== "candidates") throw new Error("Invalid fixture");
  return { source: "recommend", bossJobKeyword: "英语老师", searchKeyword: null, resumeScreeningAttempts: attempts, candidate: parsed.candidates[0]! } as ResumeScreeningJob;
}
function result(stdout: string) { return { version: "0.6.6", stdout } as Awaited<ReturnType<typeof runBossCommand>>; }

beforeEach(() => { vi.mocked(readResumeArtifact).mockResolvedValue({ version: 1, complete: true, capturedAt: null, contentHeight: 1600, contentWidth: 900, parts: [] }); run.mockReset(); recover.mockReset(); recover.mockResolvedValue(null); });
describe("resume task context recovery", () => {
  it.each([1, 2])("restores the original job and resolves a rotated card before attempt %i", async (attempt) => {
    // The shared browser was left on a different job by collection/contact work.
    run.mockResolvedValueOnce(result(list("replacement-card-id")))
      .mockResolvedValueOnce(result("简历预览截图：/tmp/fixture.png\n在线简历 OCR 正文：\n英语专业八级，五年教学经验"));
    const preview = await readSingleResumePreviewAttempt(job(attempt), "boss");
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { type: "recommend", jobKeyword: "英语老师" },
      { type: "preview", candidateTarget: "测试候选人", sourceLocator: { kind: "boss_geek_id", value: "replacement-card-id" } }
    ]);
    expect(preview.resumeText).toContain("英语专业八级");
  });
  it("does not click an unrelated namesake when the original card has disappeared", async () => {
    run.mockResolvedValueOnce(result(list("replacement-card-id", "北京 / 1年 / 专科")));
    const account = vi.fn();
    await expect(readSingleResumePreviewAttempt(job(), "boss", account)).rejects.toThrow("BOSS_SOURCE_EXPIRED");
    expect(run).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledOnce();
    expect(account).not.toHaveBeenCalled();
  });
  it("accounts only after recovering a later list batch and before its one preview", async () => {
    const expected = job();
    const events: string[] = [];
    run.mockResolvedValueOnce(result('常规推荐（0）'));
    recover.mockImplementation(async () => { events.push('located'); return expected.candidate; });
    run.mockImplementationOnce(async () => { events.push('preview'); return result('简历预览截图：/tmp/fixture.png'); });
    await readSingleResumePreviewAttempt(expected, 'boss', async () => { events.push('accounted'); });
    expect(events).toEqual(['located', 'accounted', 'preview']);
    expect(run.mock.calls.filter(([c]) => c.type === 'preview')).toHaveLength(1);
  });
  it("does not open the recovered card when the lease/accounting check fails", async () => {
    run.mockResolvedValueOnce(result(list('original-card-id')));
    await expect(readSingleResumePreviewAttempt(job(), 'boss', async () => { throw new Error('lease lost'); })).rejects.toThrow('lease lost');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not accept a capture without a complete manifest", async () => {
    run.mockResolvedValueOnce(result(list("original-card-id"))).mockResolvedValueOnce(result("简历预览截图：/tmp/fixture.png"));
    vi.mocked(readResumeArtifact).mockResolvedValueOnce({ version: 1, complete: false, capturedAt: null, contentHeight: 1600, contentWidth: 900, parts: [] });
    const saved = vi.fn();
    await expect(readSingleResumePreviewAttempt(job(), "boss", async () => undefined, saved)).rejects.toThrow("BOSS_RESUME_INCOMPLETE");
    expect(saved).not.toHaveBeenCalled();
  });
  it("does not issue a second preview when the first click fails", async () => {
    run.mockResolvedValueOnce(result(list("original-card-id")))
      .mockRejectedValueOnce(new Error("点击后未出现在线简历 iframe"));
    await expect(readSingleResumePreviewAttempt(job(), "boss")).rejects.toThrow("未出现");
    expect(run.mock.calls.filter(([command]) => command.type === "preview")).toHaveLength(1);
  });
});
