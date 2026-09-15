export type FailedRuleEvidence = {
  capabilityId: string;
  canonicalLabel: string;
  status: "positive" | "negative" | "ambiguous";
  reasonCodes?: string[];
};

function failedRuleLabel(capabilityId: string, canonicalLabel: string): string {
  switch (capabilityId.toLowerCase()) {
    case "language.english.tem8":
      return "TEM8 英语专业八级";
    case "language.english.credentials":
      return "英语证书";
    case "enum.bossplatformtags":
      return "BOSS 院校标签";
    case "education.education_level":
      return "最低学历";
    case "range.yearsofexperience":
      return "工作经验";
    case "range.age":
      return "年龄";
    case "range.graduationyear":
      return "毕业年份";
    case "keyword.skills":
      return "技能";
    case "enum.location":
      return "地点";
    case "enum.gender":
      return "性别";
    case "keyword.all":
      return "全文关键词";
    default:
      return canonicalLabel;
  }
}

export function summarizeFailedRuleLabels(evidence: FailedRuleEvidence[]): string[] {
  return [
    ...new Set(
      evidence
        .filter((item) => item.status === "negative" && participates(item))
        .map((item) => failedRuleLabel(item.capabilityId, item.canonicalLabel))
        .filter(Boolean),
    ),
  ];
}

function participates(item: FailedRuleEvidence): boolean {
  return item.capabilityId !== 'enum.gender' && !item.reasonCodes?.some((reason) =>
    ['semantic_result_not_applied', 'non_qualification_condition_ignored', 'unknown_policy_ignore'].includes(reason));
}

export function summarizeMissingRuleLabels(evidence: FailedRuleEvidence[]): string[] {
  return [...new Set(evidence.filter((item) => item.status === 'ambiguous' && participates(item))
    .map((item) => failedRuleLabel(item.capabilityId, item.canonicalLabel)).filter(Boolean))];
}
