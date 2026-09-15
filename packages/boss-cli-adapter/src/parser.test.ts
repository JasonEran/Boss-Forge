import { describe, expect, it } from "vitest";
import { renderRecommendList } from "@joohw/boss-cli/dist/toolset/recommend.js";
import { parseBossOutput } from "./parser.js";

describe("boss-cli 0.6.6 output parser", () => {
  it("keeps upstream recommend highlights when an advantage is also present", () => {
    const output = renderRecommendList([
      {
        geekId: "fixture-1",
        name: "张三",
        salary: "20-25K",
        baseInfo: "北京 / 5年 / 本科",
        expect: "产品经理",
        experience: "示例公司",
        advantage: "五年产品经验",
        highlights: ["985", "双一流"],
        canGreet: true,
        hasHistoryChat: false,
        hasViewed: false
      }
    ]);
    expect(output).toContain("标签:985/双一流");
    expect(output).toContain("BOSS候选人ID:fixture-1");
    expect(output).toContain("优势: 五年产品经验");
  });

  it("parses positions", () => {
    const output = `已读取 2 个职位。
职位明细：
1. 高级英语教师｜状态:开放｜北京｜招聘中
2. 课程顾问｜状态:已关闭｜上海｜已下线`;
    const result = parseBossOutput("0.6.6", { type: "positions" }, output);
    expect(result.kind).toBe("positions");
    if (result.kind !== "positions") return;
    expect(result.positions).toEqual([
      expect.objectContaining({ index: 1, name: "高级英语教师", status: "开放" }),
      expect.objectContaining({ index: 2, name: "课程顾问", status: "已关闭" })
    ]);
  });

  it("parses recommended candidates and evidence", () => {
    const output = `推荐列表（按来源分组）：共 1 人。

常规推荐（1）
  - 1. 张三｜薪资:20-25K｜信息:北京 / 5年 / 本科｜期望:英语老师｜可打招呼
    优势:英语专业八级 / 海外教学经验

打招呼产生的推荐（0）
  - 暂无`;
    const result = parseBossOutput("0.6.6", { type: "recommend" }, output);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") return;
    expect(result.candidates).toEqual([
      expect.objectContaining({
        name: "张三",
        source: "recommend",
        fields: expect.objectContaining({ 薪资: "20-25K", 期望: "英语老师" }),
        evidence: ["英语专业八级 / 海外教学经验"]
      })
    ]);
  });

  it("extracts the stable BOSS candidate ID without exposing it as a rule field", () => {
    const output = `推荐列表（按来源分组）：共 1 人。

常规推荐（1）
  - 1. 张三｜BOSS候选人ID:253deb7b64a5b4a50nN72dS1F1ZZ｜信息:北京 / 5年 / 本科｜可打招呼
    优势:海外运营经验

打招呼产生的推荐（0）
  - 暂无`;
    const result = parseBossOutput("0.6.6", { type: "recommend" }, output);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") return;
    expect(result.candidates[0]?.sourceLocator).toEqual({
      kind: "boss_geek_id",
      value: "253deb7b64a5b4a50nN72dS1F1ZZ"
    });
    expect(result.candidates[0]?.fields.BOSS候选人ID).toBeUndefined();
    expect(result.candidates[0]?.raw).not.toContain("BOSS候选人ID");
  });

  it("keeps recommend highlights as explicit BOSS academic platform tags", () => {
    const output = `推荐列表（按来源分组）：共 1 人。

常规推荐（1）
  - 1. 张三｜薪资:20-25K｜信息:北京 / 5年 / 本科｜期望:产品经理｜标签:985院校/211/双一流大学｜可打招呼
    优势:五年产品经验`;
    const result = parseBossOutput("0.6.6", { type: "recommend" }, output);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") return;
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          标签: "985院校/211/双一流大学",
          BOSS平台标签: "985/211/双一流"
        }),
        evidence: ["五年产品经验"]
      })
    );
  });

  it("deduplicates repeated candidate cards while preserving the first source index", () => {
    const output = `推荐列表（按来源分组）：共 3 人。

常规推荐（3）
  - 1. 张三｜薪资:20-25K｜信息:北京 / 5年 / 本科｜期望:英语老师｜可打招呼
    优势:英语专业八级 / 海外教学经验
  - 2. 张三｜薪资:20-25K｜信息:北京 / 5年 / 本科｜期望:英语老师｜可打招呼
    优势:英语专业八级 / 海外教学经验
  - 3. 李四｜薪资:15-20K｜信息:上海 / 3年 / 本科｜期望:课程顾问｜可打招呼
    优势:课程销售经验`;
    const result = parseBossOutput("0.6.6", { type: "recommend" }, output);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(({ index, name }) => ({ index, name }))).toEqual([
      { index: 1, name: "张三" },
      { index: 3, name: "李四" }
    ]);
  });

  it("parses normal search candidates", () => {
    const output = `常规搜索结果（关键词：TEM8；当前岗位：英语老师）
共 1 人

1. 李四｜刚刚活跃｜5年经验 本科｜标签:英语专业八级/教师资格证
   摘要:英语专业毕业，已取得 TEM-8
   亮点:海外教学 / 教研
   经历:示例学校 英语教师`;
    const result = parseBossOutput("0.6.6", { type: "search", keyword: "TEM8" }, output);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") return;
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        name: "李四",
        source: "search",
        evidence: [
          "摘要:英语专业毕业，已取得 TEM-8",
          "亮点:海外教学 / 教研",
          "经历:示例学校 英语教师"
        ]
      })
    );
  });

  it("normalizes only explicit search card labels and does not infer them from prose", () => {
    const output = `常规搜索结果（关键词：产品经理；当前岗位：产品经理）
共 2 人

1. 李四｜刚刚活跃｜5年经验 本科｜标签:985高校/双一流/产品专家
   摘要:负责平台产品
2. 王五｜本周活跃｜3年经验 本科｜标签:产品专家
   摘要:毕业于一所 985 大学`;
    const result = parseBossOutput("0.6.6", { type: "search", keyword: "产品经理" }, output);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") return;
    expect(result.candidates[0]?.fields.BOSS平台标签).toBe("985/双一流");
    expect(result.candidates[1]?.fields.BOSS平台标签).toBeUndefined();
  });

  it("parses deep search candidates", () => {
    const output = `深度搜索：已触发「立即匹配」。
职位：英语老师
本次新增推荐简历（最新20条）
共 1 人

1. 王五
   概要：北京 · 6年 · 本科
   经历：示例教育集团 英语教师
   教育：某大学 英语专业
   推荐：满足英语专业八级要求`;
    const result = parseBossOutput(
      "0.6.6",
      { type: "deep-search", core: ["英语专业八级"], bonus: [], match: true },
      output
    );
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") return;
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        name: "王五",
        fields: expect.objectContaining({ 推荐: "满足英语专业八级要求" })
      })
    );
  });

  it("parses resume screenshot and OCR text", () => {
    const output = `当前岗位：英语老师
简历预览截图：/private/resume/abc.png

在线简历 OCR 正文：

张三\n英语专业八级`;
    const result = parseBossOutput("0.6.6", { type: "preview", candidateTarget: "张三" }, output);
    expect(result.kind).toBe("resume");
    if (result.kind !== "resume") return;
    expect(result.resume.screenshotPath).toBe("/private/resume/abc.png");
    expect(result.resume.ocrText).toBe("张三\n英语专业八级");
  });

  it("fails closed for an unknown boss-cli version", () => {
    expect(() => parseBossOutput("0.6.7", { type: "positions" }, "职位明细：暂无。"))
      .toThrow("Unsupported boss-cli version 0.6.7");
  });
});
