/** Optional for older control requests; when supplied both ends are required. */
export function contactWindowFromPolicy(policy: unknown): { startMinute: number; endMinute: number } | null {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  const { startMinute, endMinute } = policy as Record<string, unknown>;
  if (startMinute === undefined && endMinute === undefined) return null;
  if (typeof startMinute !== 'number' || typeof endMinute !== 'number' ||
      !Number.isInteger(startMinute) || !Number.isInteger(endMinute) ||
      startMinute < 0 || endMinute > 1440 || startMinute >= endMinute) {
    throw new Error('联系时段必须在当天 00:00–24:00 内，且开始时间早于结束时间。');
  }
  return { startMinute, endMinute };
}
