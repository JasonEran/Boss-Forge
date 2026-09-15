import { describe, expect, it } from "vitest";
import { evaluateTem8 } from "./tem8.js";

describe("TEM-8 capability normalization", () => {
  it.each([
    "已取得英语专业八级证书",
    "英语专业8级",
    "持有英语专八证书",
    "专八",
    "TEM-8",
    "tem8 passed",
    "TEM 8",
    "Test for English Majors Band 8",
    "英语8级"
  ])("recognizes a confirmed alias: %s", (text) => {
    const result = evaluateTem8(text);
    expect(result.decision).toBe("matched");
    expect(result.canonicalLabel).toBe("TEM-8（英语专业八级）");
    expect(result.evidence[0]?.sourceText).toContain(text.trim().split(" ")[0]);
  });

  it.each([
    "正在备考专八",
    "计划参加 TEM-8",
    "法语专四已过,专八今年三月考,英语四级已过",
    "TEM8 明年考试",
    "下个月考专八",
    "英语八级水平",
    "能力接近专八",
    "相当于专八水平"
  ])("routes uncertain wording to human review: %s", (text) => {
    const result = evaluateTem8(text);
    expect(result.decision).toBe("ambiguous");
    if (/考|考试|备考|计划/u.test(text)) {
      expect(result.reasonCodes).toContain("planned_or_in_progress");
    }
  });

  it.each(["专八未通过", "未通过 TEM8", "没有取得英语专业八级证书"]) (
    "rejects negative evidence: %s",
    (text) => {
      const result = evaluateTem8(text);
      expect(result.decision).toBe("not_matched");
      expect(result.reasonCodes).toContain("negative_context");
    }
  );

  it.each(["CET-6", "大学英语六级", "英语六级", "英语专业四级", "雅思 8 分", "IELTS 8.0"]) (
    "does not confuse a different credential with TEM-8: %s",
    (text) => {
      const result = evaluateTem8(text);
      expect(result.decision).toBe("insufficient");
      expect(result.confidence).toBe(0);
      expect(result.reasonCodes).toEqual(["confusable_credential"]);
    }
  );

  it.each([
    ["大学英语六级 520 分", "CET-6（大学英语六级）"],
    ["英语六级 560 分", "CET-6（大学英语六级）"],
    ["英语专业四级，IELTS 7.5", "TEM-4（英语专业四级） / IELTS 7.5"],
    ["TOEFL 103", "TOEFL 103"],
    ["BEC Higher", "BEC Higher"]
  ])("reports explicit current English credentials: %s", (text, expected) => {
    const result = evaluateTem8(text);
    expect(result.detectedEnglishLevels.map((item) => item.label).join(" / ")).toBe(expected);
  });

  it("does not report a credential that was not passed", () => {
    expect(evaluateTem8("CET-6 未通过").detectedEnglishLevels).toEqual([]);
  });

  it("marks conflicting evidence as ambiguous", () => {
    const result = evaluateTem8("2024年通过TEM8；备注：专八未通过，待核实");
    expect(result.decision).toBe("ambiguous");
    expect(result.reasonCodes).toEqual(["conflicting_evidence"]);
  });

  it("keeps missing evidence separate from a failed requirement", () => {
    const result = evaluateTem8("英语专业本科毕业，口语流利");
    expect(result.decision).toBe("insufficient");
    expect(result.reasonCodes).toEqual(["no_evidence"]);
  });

  it.each([
    ["TEM-8", 0.99],
    ["英语专八", 0.97],
    ["专八", 0.95],
    ["英语八级", 0.86]
  ])("keeps alias confidence when classifying TEM-8: %s", (text, confidence) => {
    const result = evaluateTem8(text);
    expect(result.decision).toBe("matched");
    expect(result.confidence).toBe(confidence);
    expect(result.evidence[0]?.confidence).toBe(confidence);
    expect(result.detectedEnglishLevels[0]).toMatchObject({
      code: "tem8",
      label: "TEM-8（英语专业八级）",
      confidence
    });
  });
});
