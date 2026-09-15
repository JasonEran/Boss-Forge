import { describe, expect, it, vi } from "vitest";

const acquire = vi.fn();
vi.mock("./account-lock.js", () => ({ acquireAccountLock: acquire }));

const { withScreeningBrowser } = await import("./workspace-browser.js");

describe("screening browser release handoff", () => {
  it("shares the explicit and finally release promise", async () => {
    let finish!: () => void;
    const releasePromise = new Promise<void>(resolve => { finish = resolve; });
    const release = vi.fn(() => releasePromise);
    acquire.mockResolvedValue({ release });

    let first!: Promise<void>;
    let second!: Promise<void>;
    const operation = async (releaseBrowser: () => Promise<void>) => {
      first = releaseBrowser();
      second = releaseBrowser();
      expect(first).toBe(second);
      finish();
      await first;
      return true;
    };

    expect(await withScreeningBrowser(
      "account-test",
      { communicationActive: async () => false },
      operation,
    )).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await first).toBeUndefined();
  });
});
