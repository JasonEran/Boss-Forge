import { describe, expect, it, vi } from "vitest";
import {
  classifyWorkerHeartbeat,
  inspectBossTargets,
  verifyBossPageSessions,
  verifyBossPageSessionsWithRetry,
  workerHeartbeatIsFresh
} from "./session-health.js";

describe("authenticated BOSS session health", () => {
  it("accepts an authenticated BOSS work page", () => {
    expect(
      inspectBossTargets([
        {
          type: "page",
          url: "https://www.zhipin.com/web/chat/recommend"
        }
      ])
    ).toMatchObject({ state: "authenticated" });
  });

  it("fails closed on login, verification and missing BOSS pages", () => {
    expect(
      inspectBossTargets([{ type: "page", url: "https://www.zhipin.com/web/user/" }])
    ).toMatchObject({ state: "login_required" });
    expect(
      inspectBossTargets([
        { type: "page", url: "https://www.zhipin.com/web/user/safe/verify" }
      ])
    ).toMatchObject({ state: "risk_controlled" });
    expect(
      inspectBossTargets([{ type: "page", url: "https://example.com/" }])
    ).toMatchObject({ state: "unavailable" });
  });

  it("does not trust lookalike domains", () => {
    expect(
      inspectBossTargets([
        { type: "page", url: "https://www.zhipin.com.example.test/web/chat/recommend" },
        { type: "page", url: "https://evilzhipin.com/web/chat/recommend" }
      ])
    ).toMatchObject({ state: "unavailable" });
  });

  it("does not mistake a public BOSS page for the authenticated recruiter shell", () => {
    expect(
      inspectBossTargets([
        { type: "page", url: "https://www.zhipin.com/job_detail/example.html" }
      ])
    ).toMatchObject({ state: "unavailable" });
  });

  it("requires read-only logged-in DOM signals in addition to a chat URL", async () => {
    const page = { url: () => "https://www.zhipin.com/web/chat/recommend" };
    await expect(
      verifyBossPageSessions([page], async () => ({
        loggedIn: false,
        url: page.url()
      }))
    ).resolves.toMatchObject({ state: "unavailable" });
    await expect(
      verifyBossPageSessions([page], async () => ({
        loggedIn: true,
        url: page.url()
      }))
    ).resolves.toMatchObject({ state: "authenticated" });
  });

  it("fails closed if the page leaves the authenticated shell during the DOM probe", async () => {
    let currentUrl = "https://www.zhipin.com/web/chat/recommend";
    const page = { url: () => currentUrl };
    await expect(
      verifyBossPageSessions([page], async () => {
        const probedUrl = currentUrl;
        currentUrl = "https://www.zhipin.com/web/user/";
        return { loggedIn: true, url: probedUrl };
      })
    ).resolves.toEqual({
      state: "login_required",
      url: "https://www.zhipin.com/web/user/"
    });
  });

  it("prioritizes a verification page over any authenticated-looking tab", async () => {
    const pages = [
      { url: () => "https://www.zhipin.com/web/chat/recommend" },
      { url: () => "https://www.zhipin.com/web/common/security-check" }
    ];
    await expect(
      verifyBossPageSessions(pages, async (page) => ({
        loggedIn: true,
        url: page.url()
      }))
    ).resolves.toMatchObject({ state: "risk_controlled" });
  });

  it("requires a fresh live worker heartbeat", () => {
    const now = Date.parse("2026-09-04T00:00:30.000Z");
    expect(
      workerHeartbeatIsFresh(
        { state: "ready", observedAt: "2026-09-04T00:00:20.000Z" },
        now
      )
    ).toBe(true);
    expect(
      workerHeartbeatIsFresh(
        { state: "ready", observedAt: "2026-09-03T23:59:00.000Z" },
        now
      )
    ).toBe(false);
    expect(
      workerHeartbeatIsFresh(
        { state: "stopping", observedAt: "2026-09-04T00:00:29.000Z" },
        now
      )
    ).toBe(false);
  });
});

describe("worker heartbeat startup classification", () => {
  const startedAt = Date.parse("2026-09-04T01:00:00.000Z");
  const heartbeat = (observedAt: string) => ({
    state: "ready",
    observedAt
  });

  it("waits for this worker to replace a stale heartbeat during grace", () => {
    expect(
      classifyWorkerHeartbeat(
        heartbeat("2026-09-04T00:59:55.000Z"),
        startedAt,
        startedAt + 5_000
      )
    ).toBe("starting");
  });

  it("does not claim authentication before the first heartbeat exists", () => {
    expect(classifyWorkerHeartbeat(null, startedAt, startedAt + 5_000)).toBe(
      "starting"
    );
  });

  it("accepts only a fresh heartbeat written after this worker started", () => {
    expect(
      classifyWorkerHeartbeat(
        heartbeat("2026-09-04T01:00:01.000Z"),
        startedAt,
        startedAt + 5_000
      )
    ).toBe("fresh");
  });

  it("fails closed when no current heartbeat arrives before grace ends", () => {
    expect(classifyWorkerHeartbeat(null, startedAt, startedAt + 60_000)).toBe(
      "failed"
    );
    expect(
      classifyWorkerHeartbeat(
        heartbeat("2026-09-04T00:59:59.000Z"),
        startedAt,
        startedAt + 60_000
      )
    ).toBe("failed");
  });

  it("accepts only a current stopping heartbeat with explicit completion context", () => {
    const stopping = {
      state: "stopping",
      observedAt: "2026-09-04T01:01:00.000Z"
    };
    expect(
      classifyWorkerHeartbeat(
        stopping,
        startedAt,
        startedAt + 60_000,
        60_000,
        20_000,
        { acceptStoppingAsCompleted: true }
      )
    ).toBe("completed");
    expect(
      classifyWorkerHeartbeat(
        stopping,
        startedAt,
        startedAt + 60_000,
        60_000,
        20_000
      )
    ).toBe("failed");
    expect(
      classifyWorkerHeartbeat(
        { state: "stopping", observedAt: "2026-09-04T00:59:59.000Z" },
        startedAt,
        startedAt + 60_000,
        60_000,
        20_000,
        { acceptStoppingAsCompleted: true }
      )
    ).toBe("failed");
  });
});


describe("navigation during session checks", () => {
  const page = { url: () => "https://www.zhipin.com/web/chat/recommend" };
  it("reacquires pages after a transient destroyed execution context", async () => {
    const pages = vi.fn().mockResolvedValue([page]);
    const probe = vi.fn().mockRejectedValueOnce(new Error("Execution context was destroyed, most likely because of a navigation."))
      .mockResolvedValue({ loggedIn: true, url: page.url() });
    await expect(verifyBossPageSessionsWithRetry(pages, probe, async () => undefined)).resolves.toMatchObject({ state: "authenticated" });
    expect(pages).toHaveBeenCalledTimes(2);
  });
  it("stops after a real login transition instead of assuming the old session", async () => {
    const pages = vi.fn().mockResolvedValueOnce([page]).mockResolvedValue([{ url: () => "https://www.zhipin.com/web/user/" }]);
    const probe = vi.fn().mockRejectedValue(new Error("Execution context was destroyed"));
    await expect(verifyBossPageSessionsWithRetry(pages, probe, async () => undefined)).resolves.toMatchObject({ state: "login_required" });
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it("bounds repeated transient failures and does not retry unrelated CDP failures", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("Execution context was destroyed"));
    await expect(verifyBossPageSessionsWithRetry(async () => [page], probe, async () => undefined)).rejects.toThrow("Execution context");
    expect(probe).toHaveBeenCalledTimes(3);
    probe.mockReset().mockRejectedValue(new Error("Connection closed"));
    await expect(verifyBossPageSessionsWithRetry(async () => [page], probe, async () => undefined)).rejects.toThrow("Connection closed");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
