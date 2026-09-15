/** CLI metadata records the actual selected job, not the optional UI keyword. */
export function collectedRecommendJobLabel(raw: string): string | null {
  const value = raw.match(/^当前岗位[：:]\s*(.+)$/mu)?.[1]?.trim();
  return value && value !== "默认" ? value : null;
}
