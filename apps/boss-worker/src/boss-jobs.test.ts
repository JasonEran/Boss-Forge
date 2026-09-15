import { describe, expect, it } from "vitest";
import { collectBossJobCatalog, selectExactJobOption, type JobOption } from "./boss-jobs.js";
const option = (id: string, name: string, index = 0): JobOption => ({ id, name, label: name, disabled: false, index });

describe("BOSS recommendation job binding", () => {
  it("selects the bound ID among identical names", () => {
    expect(selectExactJobOption([option("a", "运营"), option("b", "运营", 1)],
      { id: "b", name: "运营", allowNameFallback: false }).index).toBe(1);
  });
  it("does not pick a prefix, substring or current unrelated job", () => {
    expect(() => selectExactJobOption([option("", "海外运营主管")],
      { id: "b", name: "运营", allowNameFallback: true })).toThrow("BOSS_JOB_NOT_FOUND");
  });
  it("allows a unique exact full name on older dropdowns without IDs", () => {
    expect(selectExactJobOption([option("", "海外 运营")],
      { id: "b", name: "海外运营", allowNameFallback: true }).name).toBe("海外 运营");
  });
  it("does not use name fallback for duplicate catalog names or a conflicting ID", () => {
    expect(() => selectExactJobOption([option("", "运营")],
      { id: "b", name: "运营", allowNameFallback: false })).toThrow("BOSS_JOB_NOT_FOUND");
    expect(() => selectExactJobOption([option("a", "运营")],
      { id: "b", name: "运营", allowNameFallback: true })).toThrow("BOSS_JOB_NOT_FOUND");
  });
  it("rejects duplicate dropdown options and disabled jobs", () => {
    expect(() => selectExactJobOption([option("", "运营"), option("", "运营")],
      { id: "b", name: "运营", allowNameFallback: true })).toThrow("BOSS_JOB_AMBIGUOUS");
    expect(() => selectExactJobOption([{ ...option("b", "运营"), disabled: true }],
      { id: "b", name: "运营", allowNameFallback: false })).toThrow("BOSS_JOB_UNAVAILABLE");
  });
});

describe("BOSS job pagination", () => {
  const a = { id: "a", name: "运营", status: "开放中" };
  const b = { id: "b", name: "运营", status: "已关闭" };
  it("reads all pages, deduplicates overlap by ID, and retains same-name jobs", async () => {
    let page = 0;
    const result = await collectBossJobCatalog(async () => ({ total: 2, jobs: page ? [a, b] : [a] }), async () => { page++; return true; });
    expect(result).toEqual({ complete: true, jobs: [a, b] });
    expect(page).toBe(1);
  });
  it("never calls a truncated or unknown-size list complete", async () => {
    expect((await collectBossJobCatalog(async () => ({ total: 2, jobs: [a] }), async () => false)).complete).toBe(false);
    expect((await collectBossJobCatalog(async () => ({ total: null, jobs: [a] }), async () => false)).complete).toBe(false);
  });
  it("accepts an explicitly empty list but rejects changing totals and stuck pagination", async () => {
    expect(await collectBossJobCatalog(async () => ({ total: 0, jobs: [] }), async () => { throw new Error("Must not advance"); })).toEqual({ complete: true, jobs: [] });
    let page = 0;
    await expect(collectBossJobCatalog(async () => ({ total: page ? 3 : 2, jobs: [a] }), async () => { page++; return true; })).rejects.toThrow("发生变化");
    await expect(collectBossJobCatalog(async () => ({ total: 2, jobs: [a] }), async () => true)).rejects.toThrow("读取范围");
  });
});
