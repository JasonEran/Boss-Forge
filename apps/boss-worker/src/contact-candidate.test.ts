import { describe, expect, it, vi } from "vitest";
import type { ParsedCandidate } from "@boss-forge/contracts";
import type { ContactDispatchJob } from "@boss-forge/data";
import { contactCandidateJob, findContactCandidateInBatches } from "./contact-candidate.js";

const candidate = (id: string, name = "同名候选人"): ParsedCandidate => ({
  index: 1, name, source: "recommend", sourceLocator: { kind: "boss_geek_id", value: id },
  fields: { 薪资: "8-12K" }, evidence: [], raw: name
});
const target = candidate("original-geek-id");

describe("contact identity recovery", () => {
  it("loads later batches until the original ID appears, then stops immediately", async () => {
    const updated = { ...target, index: 106, fields: { 薪资: "9-12K" } };
    const read = vi.fn().mockResolvedValueOnce({ candidates: [candidate("other-id")], ended: false })
      .mockResolvedValueOnce({ candidates: [candidate("another-id")], ended: false })
      .mockResolvedValue({ candidates: [updated], ended: false });
    const advance = vi.fn().mockResolvedValue(undefined);
    expect(await findContactCandidateInBatches(target, { read, advance })).toEqual(updated);
    expect(advance).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not refresh a list that already contains the exact target", async () => {
    const advance = vi.fn();
    expect(await findContactCandidateInBatches(target, { read: async () => ({ candidates: [target], ended: false }), advance })).toEqual(target);
    expect(advance).not.toHaveBeenCalled();
  });

  it("never substitutes identical names and card fields with another provider ID", async () => {
    const advance = vi.fn();
    await expect(findContactCandidateInBatches(target, {
      read: async () => ({ candidates: [candidate("replacement-id")], ended: true }), advance
    })).rejects.toThrow("BOSS_CONTACT_TARGET_UNAVAILABLE");
    expect(advance).not.toHaveBeenCalled();
  });

  it("stops on duplicate original IDs instead of selecting a card arbitrarily", async () => {
    const advance = vi.fn();
    await expect(findContactCandidateInBatches(target, {
      read: async () => ({ candidates: [target, target], ended: false }), advance
    })).rejects.toThrow("BOSS_TARGET_AMBIGUOUS");
    expect(advance).not.toHaveBeenCalled();
  });

  it("distinguishes bounded lookup from a list confirmed exhausted", async () => {
    const advance = vi.fn().mockResolvedValue(undefined);
    await expect(findContactCandidateInBatches(target, {
      read: async () => ({ candidates: [], ended: false }), advance, maxPages: 2
    })).rejects.toThrow("BOSS_CONTACT_LOCATE_INCOMPLETE");
    expect(advance).toHaveBeenCalledOnce();
  });

  it("stops at the time budget without marking the target expired", async () => {
    const advance = vi.fn();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(120_000);
    await expect(findContactCandidateInBatches(target, {
      read: async () => ({ candidates: [], ended: false }), advance, now
    })).rejects.toThrow("BOSS_CONTACT_LOCATE_INCOMPLETE");
    expect(advance).not.toHaveBeenCalled();
  });

  it("does not hide provider errors or start another page after a failed read", async () => {
    const advance = vi.fn();
    await expect(findContactCandidateInBatches(target, {
      read: async () => { throw new Error("BOSS login required"); }, advance
    })).rejects.toThrow("BOSS login required");
    expect(advance).not.toHaveBeenCalled();
  });

  it("requires an original stable identifier before reading anything", async () => {
    const { sourceLocator: _, ...legacy } = target;
    const read = vi.fn();
    await expect(findContactCandidateInBatches(legacy, { read, advance: vi.fn() })).rejects.toThrow("BOSS_STABLE_LOCATOR_MISSING");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("frozen contact job context", () => {
  const job = { actionKind: "greet", bossJobId: "original-job", bossJobKeyword: "亚马逊运营",
    providerJobId: "original-job", bossJobNameUnique: false,
    sourceBossFilters: { version: 1, mode: "custom", fields: { major: ["英语"] } } } as ContactDispatchJob;

  it("uses the captured job ID and official filters with no partial-name fallback", () => {
    expect(contactCandidateJob(job)).toEqual({ id: "original-job", name: "亚马逊运营", allowNameFallback: false, filters: job.sourceBossFilters });
  });
  it("rejects a greeting approved for a different job before navigation", () => {
    expect(() => contactCandidateJob({ ...job, providerJobId: "different-job" })).toThrow("BOSS_CONTACT_JOB_MISMATCH");
    expect(() => contactCandidateJob({ ...job, bossJobId: null })).toThrow("BOSS_CONTACT_JOB_MISMATCH");
  });
});
